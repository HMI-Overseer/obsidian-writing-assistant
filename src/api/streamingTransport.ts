import * as http from "http";
import * as https from "https";
import { createAbortError } from "./httpTransport";

export async function* streamNode(
  url: string,
  body: string,
  signal?: AbortSignal
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
      },
    };

    req = lib.request(options, (res) => {
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

          try {
            const delta = JSON.parse(payload).choices?.[0]?.delta?.content;
            if (delta) {
              queue.push(delta);
              notify();
            }
          } catch {
            // Skip malformed chunks from the stream.
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
  signal?: AbortSignal
): AsyncGenerator<string> {
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body,
    signal,
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  if (!res.body) throw new Error("No response body");

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

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

      try {
        const delta = JSON.parse(payload).choices?.[0]?.delta?.content;
        if (delta) yield delta;
      } catch {
        // Skip malformed chunks from the stream.
      }
    }
  }
}
