import type { Message } from "../shared/types";
import * as http from "http";
import * as https from "https";

function createAbortError(): Error {
  const error = new Error("The request was aborted.");
  error.name = "AbortError";
  return error;
}

export class LMStudioClient {
  constructor(
    private baseUrl: string,
    private bypassCors: boolean = true
  ) {}

  private nodeRequest(
    method: "GET" | "POST",
    path: string,
    body?: string,
    signal?: AbortSignal
  ): Promise<string> {
    return new Promise((resolve, reject) => {
      if (signal?.aborted) {
        reject(createAbortError());
        return;
      }

      const url = new URL(this.baseUrl + path);
      const lib = url.protocol === "https:" ? https : http;

      const options: http.RequestOptions = {
        hostname: url.hostname,
        port: parseInt(url.port) || (url.protocol === "https:" ? 443 : 80),
        path: url.pathname,
        method,
        headers: {
          "Content-Type": "application/json",
          ...(body ? { "Content-Length": Buffer.byteLength(body) } : {}),
        },
      };

      const req = lib.request(options, (res) => {
        let data = "";
        res.on("data", (chunk: Buffer) => (data += chunk.toString()));
        res.on("end", () => {
          if (res.statusCode && res.statusCode >= 400) {
            reject(new Error(`HTTP ${res.statusCode}: ${data}`));
            return;
          }
          resolve(data);
        });
        res.on("error", reject);
      });

      const abortHandler = () => {
        req.destroy(createAbortError());
      };

      signal?.addEventListener("abort", abortHandler, { once: true });
      req.on("close", () => signal?.removeEventListener("abort", abortHandler));
      req.on("error", reject);
      if (body) req.write(body);
      req.end();
    });
  }

  async listModels(signal?: AbortSignal): Promise<string[]> {
    if (this.bypassCors) {
      const data = await this.nodeRequest("GET", "/models", undefined, signal);
      const json = JSON.parse(data);
      return (json.data as { id: string }[]).map((model) => model.id);
    }

    const res = await fetch(`${this.baseUrl}/models`, { signal });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const json = await res.json();
    return (json.data as { id: string }[]).map((model) => model.id);
  }

  async complete(
    messages: Message[],
    model: string,
    maxTokens: number,
    temperature: number,
    signal?: AbortSignal
  ): Promise<string> {
    const payload = JSON.stringify({
      model,
      messages,
      max_tokens: maxTokens,
      temperature,
      stream: false,
    });

    if (this.bypassCors) {
      const data = await this.nodeRequest("POST", "/chat/completions", payload, signal);
      const json = JSON.parse(data);
      return json.choices[0].message.content as string;
    }

    const res = await fetch(`${this.baseUrl}/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: payload,
      signal,
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const json = await res.json();
    return json.choices[0].message.content as string;
  }

  async *stream(
    messages: Message[],
    model: string,
    maxTokens: number,
    temperature: number,
    signal?: AbortSignal
  ): AsyncGenerator<string> {
    if (this.bypassCors) {
      yield* this.streamNode(messages, model, maxTokens, temperature, signal);
      return;
    }

    yield* this.streamFetch(messages, model, maxTokens, temperature, signal);
  }

  private async *streamNode(
    messages: Message[],
    model: string,
    maxTokens: number,
    temperature: number,
    signal?: AbortSignal
  ): AsyncGenerator<string> {
    if (signal?.aborted) throw createAbortError();

    const url = new URL(`${this.baseUrl}/chat/completions`);
    const lib = url.protocol === "https:" ? https : http;
    const body = JSON.stringify({
      model,
      messages,
      max_tokens: maxTokens,
      temperature,
      stream: true,
    });

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
        hostname: url.hostname,
        port: parseInt(url.port) || (url.protocol === "https:" ? 443 : 80),
        path: url.pathname,
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

  private async *streamFetch(
    messages: Message[],
    model: string,
    maxTokens: number,
    temperature: number,
    signal?: AbortSignal
  ): AsyncGenerator<string> {
    const res = await fetch(`${this.baseUrl}/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model,
        messages,
        max_tokens: maxTokens,
        temperature,
        stream: true,
      }),
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
}
