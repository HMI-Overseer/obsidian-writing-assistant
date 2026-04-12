import * as http from "http";
import * as https from "https";
import { createAbortError } from "./httpTransport";

/** Extracts a text delta from a parsed SSE JSON payload. Returns null if the event is not a text delta. */
export type DeltaExtractor = (json: unknown) => string | null;

/** Default extractor for OpenAI-compatible SSE streams. */
export function openAIDeltaExtractor(json: unknown): string | null {
  const record = json as Record<string, unknown>;
  const choices = record.choices as Array<{ delta?: { content?: string } }> | undefined;
  return choices?.[0]?.delta?.content ?? null;
}

/** Extracts an error message from an SSE event payload, or returns null if the event is not an error. */
export function extractSSEError(json: unknown): string | null {
  const record = json as Record<string, unknown>;
  if (!record.error) return null;
  if (typeof record.error === "string") return record.error;
  if (typeof record.error === "object") {
    const err = record.error as Record<string, unknown>;
    if (typeof err.message === "string") return err.message;
  }
  return "Unknown streaming error";
}

export async function* streamNode(
  url: string,
  body: string,
  signal?: AbortSignal,
  headers?: Record<string, string>,
  extractDelta: DeltaExtractor = openAIDeltaExtractor,
  onEvent?: (json: unknown) => void
): AsyncGenerator<string> {
  if (signal?.aborted) throw createAbortError();

  const parsed = new URL(url);
  const lib = parsed.protocol === "https:" ? https : http;

  const queue: string[] = [];
  let done = false;
  let error: Error | null = null;
  let wake: (() => void) | null = null;
  let req: http.ClientRequest | null = null;

  const notify = () => {
    if (wake) {
      wake();
      wake = null;
    }
  };

  const abortHandler = () => {
    error = createAbortError();
    done = true;
    req?.destroy(error);
    notify();
  };

  signal?.addEventListener("abort", abortHandler, { once: true });

  try {
    const options: http.RequestOptions = {
      hostname: parsed.hostname,
      port: parseInt(parsed.port, 10) || (parsed.protocol === "https:" ? 443 : 80),
      path: parsed.pathname,
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Content-Length": Buffer.byteLength(body),
        ...headers,
      },
    };

    req = lib.request(options, (res) => {
      // Check for HTTP errors before processing the stream.
      // Without this, error responses (401, 400, 429, etc.) are silently
      // fed through the SSE parser, yielding zero deltas and producing an
      // empty response with no error shown to the user.
      if (res.statusCode && res.statusCode >= 400) {
        let errorBody = "";
        res.on("data", (chunk: Buffer) => (errorBody += chunk.toString()));
        res.on("end", () => {
          let message = `HTTP ${res.statusCode}`;
          try {
            const parsed = JSON.parse(errorBody) as Record<string, unknown>;
            const err = parsed.error as Record<string, unknown> | undefined;
            if (typeof err?.message === "string") message += `: ${err.message}`;
          } catch {
            if (errorBody.length > 0 && errorBody.length < 200) message += `: ${errorBody}`;
          }
          error = new Error(message);
          done = true;
          notify();
        });
        return;
      }

      let buffer = "";
      res.on("data", (chunk: Buffer) => {
        buffer += chunk.toString();
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";

        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed.startsWith("data: ")) continue;
          const payload = trimmed.slice(6);
          if (payload === "[DONE]") continue;

          let parsed: unknown;
          try {
            parsed = JSON.parse(payload);
          } catch {
            continue; // Skip malformed chunks from the stream.
          }

          onEvent?.(parsed);

          const sseError = extractSSEError(parsed);
          if (sseError) {
            error = new Error(sseError);
            done = true;
            notify();
            return;
          }

          const delta = extractDelta(parsed);
          if (delta) {
            queue.push(delta);
            notify();
          }
        }
      });
      res.on("end", () => {
        done = true;
        notify();
      });
      res.on("error", (streamError: Error) => {
        error = streamError;
        done = true;
        notify();
      });
    });

    req.on("error", (requestError: Error) => {
      error = requestError;
      done = true;
      notify();
    });
    req.write(body);
    req.end();

    while (true) {
      if (queue.length > 0) {
        const token = queue.shift();
        if (token !== undefined) yield token;
      } else if (done) {
        break;
      } else {
        await new Promise<void>((resolve) => {
          wake = resolve;
        });
      }
    }
  } finally {
    signal?.removeEventListener("abort", abortHandler);
  }

  if (error) throw error;
}

export async function* streamFetch(
  url: string,
  body: string,
  signal?: AbortSignal,
  headers?: Record<string, string>,
  extractDelta: DeltaExtractor = openAIDeltaExtractor,
  onEvent?: (json: unknown) => void
): AsyncGenerator<string> {
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body,
    signal,
    redirect: "error",
  });
  if (!res.ok) {
    const errorBody = await res.text().catch(() => "");
    let message = `HTTP ${res.status}`;
    try {
      const parsed = JSON.parse(errorBody) as Record<string, unknown>;
      const err = parsed.error as Record<string, unknown> | undefined;
      if (typeof err?.message === "string") message += `: ${err.message}`;
    } catch {
      if (errorBody.length > 0 && errorBody.length < 200) message += `: ${errorBody}`;
    }
    throw new Error(message);
  }
  if (!res.body) throw new Error("No response body");

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed.startsWith("data: ")) continue;
        const payload = trimmed.slice(6);
        if (payload === "[DONE]") return;

        let parsed: unknown;
        try {
          parsed = JSON.parse(payload);
        } catch {
          continue; // Skip malformed chunks from the stream.
        }

        onEvent?.(parsed);

        const sseError = extractSSEError(parsed);
        if (sseError) throw new Error(sseError);

        const delta = extractDelta(parsed);
        if (delta) yield delta;
      }
    }
  } finally {
    await reader.cancel();
  }
}
