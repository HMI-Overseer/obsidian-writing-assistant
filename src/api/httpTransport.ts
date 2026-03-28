import * as http from "http";
import * as https from "https";
import type { RequestMethod } from "./types";

export function createAbortError(): Error {
  const error = new Error("The request was aborted.");
  error.name = "AbortError";
  return error;
}

export function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function createModelListError(nativeError: unknown, openAIError: unknown): Error {
  return new Error(
    `Failed to fetch models from LM Studio. Native /api/v1/models error: ${formatError(
      nativeError
    )}. OpenAI-compatible /v1/models error: ${formatError(openAIError)}.`
  );
}

export function nodeRequest(
  method: RequestMethod,
  baseUrl: string,
  path: string,
  body?: string,
  signal?: AbortSignal
): Promise<string> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(createAbortError());
      return;
    }

    const url = new URL(`${baseUrl}${path}`);
    const lib = url.protocol === "https:" ? https : http;

    const options: http.RequestOptions = {
      hostname: url.hostname,
      port: parseInt(url.port, 10) || (url.protocol === "https:" ? 443 : 80),
      path: `${url.pathname}${url.search}`,
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

export async function fetchRequest(
  method: RequestMethod,
  baseUrl: string,
  path: string,
  body?: string,
  signal?: AbortSignal
): Promise<string> {
  const res = await fetch(`${baseUrl}${path}`, {
    method,
    headers: { "Content-Type": "application/json" },
    ...(body ? { body } : {}),
    signal,
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.text();
}

export async function request(
  method: RequestMethod,
  baseUrl: string,
  path: string,
  bypassCors: boolean,
  body?: string,
  signal?: AbortSignal
): Promise<string> {
  if (bypassCors) {
    return nodeRequest(method, baseUrl, path, body, signal);
  }
  return fetchRequest(method, baseUrl, path, body, signal);
}

export async function requestJson(
  method: RequestMethod,
  baseUrl: string,
  path: string,
  bypassCors: boolean,
  body?: string,
  signal?: AbortSignal
): Promise<unknown> {
  return JSON.parse(await request(method, baseUrl, path, bypassCors, body, signal));
}
