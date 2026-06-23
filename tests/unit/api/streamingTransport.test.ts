import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// Mock the Node http/https modules so streamNode's request path is driven by the
// test instead of hitting the network. The mock records the response callback so
// the test can deliver an IncomingMessage-like emitter and drive its events with
// full control over timing.
const nodeMock = vi.hoisted(() => {
  function makeEmitter(): Record<string, unknown> & {
    on: (event: string, fn: (...args: unknown[]) => void) => unknown;
    emit: (event: string, ...args: unknown[]) => boolean;
  } {
    const handlers: Record<string, Array<(...args: unknown[]) => void>> = {};
    const em = {
      on(event: string, fn: (...args: unknown[]) => void) {
        (handlers[event] ||= []).push(fn);
        return em;
      },
      emit(event: string, ...args: unknown[]) {
        (handlers[event] || []).forEach((fn) => fn(...args));
        return true;
      },
    } as Record<string, unknown> & {
      on: (event: string, fn: (...args: unknown[]) => void) => unknown;
      emit: (event: string, ...args: unknown[]) => boolean;
    };
    return em;
  }

  const state: {
    options: unknown;
    cb: ((res: unknown) => void) | null;
    req: ReturnType<typeof makeEmitter> | null;
  } = { options: null, cb: null, req: null };

  const request = (options: unknown, cb: (res: unknown) => void) => {
    const req = makeEmitter();
    req.write = () => req;
    req.end = () => req;
    req.destroyed = false;
    req.destroy = (err?: unknown) => {
      req.destroyed = true;
      req.destroyError = err;
    };
    state.options = options;
    state.cb = cb;
    state.req = req;
    return req;
  };

  return { state, request, makeEmitter };
});

vi.mock("http", () => ({ request: nodeMock.request }));
vi.mock("https", () => ({ request: nodeMock.request }));

import { streamFetch, streamNode } from "../../../src/api/streamingTransport";

/** Collect every delta a generator yields into an array. */
async function collect(gen: AsyncGenerator<string>): Promise<string[]> {
  const out: string[] = [];
  for await (const d of gen) out.push(d);
  return out;
}

// --------------------------------------------------------------------------
// streamFetch — the fetch()/ReadableStream SSE parser
// --------------------------------------------------------------------------

/** A hand-rolled reader that replays string chunks as UTF-8 Uint8Arrays. */
function makeReader(chunks: string[]) {
  const encoder = new TextEncoder();
  let i = 0;
  return {
    read: vi.fn(async () => {
      if (i < chunks.length) return { done: false, value: encoder.encode(chunks[i++]) };
      return { done: true, value: undefined };
    }),
    cancel: vi.fn(async () => {}),
  };
}

/** Build a Response-like object for the mocked global fetch. */
function makeResponse(
  chunks: string[],
  opts: { ok?: boolean; status?: number; body?: string; hasBody?: boolean } = {},
) {
  const reader = makeReader(chunks);
  const res = {
    ok: opts.ok ?? true,
    status: opts.status ?? 200,
    body: (opts.hasBody ?? true) ? { getReader: () => reader } : null,
    text: async () => opts.body ?? "",
  };
  return { res, reader };
}

describe("streamFetch (SSE parser)", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("yields content deltas, fires onEvent per payload, and stops at [DONE]", async () => {
    const onEvent = vi.fn();
    const { res, reader } = makeResponse([
      'data: {"choices":[{"delta":{"content":"Hel"}}]}\n',
      'data: {"choices":[{"delta":{"content":"lo"}}]}\n',
      "data: [DONE]\n",
      // Anything after [DONE] must never be reached (the generator returns).
      'data: {"choices":[{"delta":{"content":"ignored"}}]}\n',
    ]);
    vi.stubGlobal("fetch", vi.fn(async () => res));

    const out = await collect(
      streamFetch("http://x/v1", "body", undefined, undefined, undefined, onEvent),
    );

    expect(out).toEqual(["Hel", "lo"]);
    expect(onEvent).toHaveBeenCalledTimes(2); // [DONE] is not parsed; the trailing chunk is unreached
    expect(reader.cancel).toHaveBeenCalled(); // finally{} cleans up the reader
  });

  it("reassembles a data line split across read() boundaries", async () => {
    const { res } = makeResponse([
      'data: {"choices":[{"delta":{"content":"Hel', // first read: line incomplete (no \n yet)
      'lo"}}]}\n', // second read: completes the buffered line
      "data: [DONE]\n",
    ]);
    vi.stubGlobal("fetch", vi.fn(async () => res));

    const out = await collect(streamFetch("http://x", "body"));

    expect(out).toEqual(["Hello"]);
  });

  it("skips non-`data:` lines (comments, event lines, blanks)", async () => {
    const onEvent = vi.fn();
    const { res } = makeResponse([
      ": keep-alive\n",
      "event: message\n",
      "\n",
      'data: {"choices":[{"delta":{"content":"Hi"}}]}\n',
      "data: [DONE]\n",
    ]);
    vi.stubGlobal("fetch", vi.fn(async () => res));

    const out = await collect(
      streamFetch("http://x", "body", undefined, undefined, undefined, onEvent),
    );

    expect(out).toEqual(["Hi"]);
    expect(onEvent).toHaveBeenCalledTimes(1);
  });

  it("skips a malformed JSON data chunk and continues", async () => {
    const onEvent = vi.fn();
    const { res } = makeResponse([
      "data: {not valid json}\n",
      'data: {"choices":[{"delta":{"content":"ok"}}]}\n',
      "data: [DONE]\n",
    ]);
    vi.stubGlobal("fetch", vi.fn(async () => res));

    const out = await collect(
      streamFetch("http://x", "body", undefined, undefined, undefined, onEvent),
    );

    expect(out).toEqual(["ok"]);
    // The malformed chunk is dropped before onEvent runs, so only the valid one is observed.
    expect(onEvent).toHaveBeenCalledTimes(1);
  });

  it("throws the error message from an HTTP error before the stream (JSON body)", async () => {
    const { res } = makeResponse([], {
      ok: false,
      status: 401,
      body: '{"error":{"message":"Invalid API key"}}',
    });
    vi.stubGlobal("fetch", vi.fn(async () => res));

    await expect(collect(streamFetch("http://x", "body"))).rejects.toThrow(
      "HTTP 401: Invalid API key",
    );
  });

  it("appends a short non-JSON error body to the HTTP status", async () => {
    const { res } = makeResponse([], { ok: false, status: 500, body: "upstream boom" });
    vi.stubGlobal("fetch", vi.fn(async () => res));

    await expect(collect(streamFetch("http://x", "body"))).rejects.toThrow("HTTP 500: upstream boom");
  });

  it("falls back to the bare status when the error body is empty", async () => {
    const { res } = makeResponse([], { ok: false, status: 429, body: "" });
    vi.stubGlobal("fetch", vi.fn(async () => res));

    await expect(collect(streamFetch("http://x", "body"))).rejects.toThrow("HTTP 429");
  });

  it("throws when the response has no body", async () => {
    const { res } = makeResponse([], { ok: true, status: 200, hasBody: false });
    vi.stubGlobal("fetch", vi.fn(async () => res));

    await expect(collect(streamFetch("http://x", "body"))).rejects.toThrow("No response body");
  });

  it("yields prior deltas then throws on an in-stream SSE error event", async () => {
    const { res } = makeResponse([
      'data: {"choices":[{"delta":{"content":"partial"}}]}\n',
      'data: {"error":{"message":"Rate limited"}}\n',
    ]);
    vi.stubGlobal("fetch", vi.fn(async () => res));

    const gen = streamFetch("http://x", "body");
    expect((await gen.next()).value).toBe("partial");
    await expect(gen.next()).rejects.toThrow("Rate limited");
  });

  it("uses a custom delta extractor when provided (Anthropic-style)", async () => {
    const extract = (json: unknown): string | null => {
      const j = json as { delta?: { text?: string } };
      return j?.delta?.text ?? null;
    };
    const { res } = makeResponse(['data: {"delta":{"text":"X"}}\n', "data: [DONE]\n"]);
    vi.stubGlobal("fetch", vi.fn(async () => res));

    const out = await collect(streamFetch("http://x", "body", undefined, undefined, extract));

    expect(out).toEqual(["X"]);
  });

  it("forwards method, headers, body, signal, and redirect to fetch", async () => {
    const { res } = makeResponse(["data: [DONE]\n"]);
    const fetchMock = vi.fn(async () => res);
    vi.stubGlobal("fetch", fetchMock);
    const controller = new AbortController();

    await collect(
      streamFetch("http://x/v1", "the-body", controller.signal, { Authorization: "Bearer k" }),
    );

    expect(fetchMock).toHaveBeenCalledWith(
      "http://x/v1",
      expect.objectContaining({
        method: "POST",
        body: "the-body",
        signal: controller.signal,
        redirect: "error",
        headers: expect.objectContaining({
          "Content-Type": "application/json",
          Authorization: "Bearer k",
        }),
      }),
    );
  });
});

// --------------------------------------------------------------------------
// streamNode — the Node http/https SSE parser (used when bypassCors is on)
// --------------------------------------------------------------------------

/** Build a mock IncomingMessage-like response emitter. */
function makeRes(statusCode = 200) {
  const res = nodeMock.makeEmitter();
  res.statusCode = statusCode;
  res.headers = {};
  return res;
}

/**
 * Kick off streamNode and start draining it. Returns synchronously once the
 * generator has suspended awaiting its first chunk, with `nodeMock.state.cb`
 * set (unless the request was never made, e.g. a pre-aborted signal).
 */
function startNode(
  opts: {
    url?: string;
    signal?: AbortSignal;
    headers?: Record<string, string>;
    extractDelta?: (json: unknown) => string | null;
    onEvent?: (json: unknown) => void;
  } = {},
) {
  const tokens: string[] = [];
  const consumed = (async () => {
    for await (const t of streamNode(
      opts.url ?? "http://localhost:1234/v1/chat/completions",
      "the-body",
      opts.signal,
      opts.headers,
      opts.extractDelta,
      opts.onEvent,
    )) {
      tokens.push(t);
    }
  })();
  consumed.catch(() => {}); // mark handled; tests await `consumed` explicitly
  return { tokens, consumed };
}

describe("streamNode (SSE parser)", () => {
  beforeEach(() => {
    nodeMock.state.options = null;
    nodeMock.state.cb = null;
    nodeMock.state.req = null;
  });

  it("parses deltas across split chunks, skips malformed lines, fires onEvent", async () => {
    const onEvent = vi.fn();
    const { tokens, consumed } = startNode({ onEvent });

    const res = makeRes(200);
    nodeMock.state.cb?.(res);
    // Line split across two data events, then a malformed line, then a good one.
    res.emit("data", Buffer.from('data: {"choices":[{"delta":{"content":"Hel'));
    res.emit("data", Buffer.from('lo"}}]}\ndata: {bad}\n'));
    res.emit("data", Buffer.from('data: {"choices":[{"delta":{"content":"!"}}]}\n'));
    res.emit("end");
    await consumed;

    expect(tokens).toEqual(["Hello", "!"]);
    expect(onEvent).toHaveBeenCalledTimes(2); // malformed line never reaches onEvent
  });

  it("treats [DONE] as a skipped line, not a terminator (continues until res end)", async () => {
    // Unlike streamFetch (which returns on [DONE]), streamNode `continue`s, so a
    // delta after [DONE] but before the socket closes is still delivered.
    const { tokens, consumed } = startNode();

    const res = makeRes(200);
    nodeMock.state.cb?.(res);
    res.emit("data", Buffer.from("data: [DONE]\n"));
    res.emit("data", Buffer.from('data: {"choices":[{"delta":{"content":"after"}}]}\n'));
    res.emit("end");
    await consumed;

    expect(tokens).toEqual(["after"]);
  });

  it("sets Content-Type and Content-Length and forwards custom headers", async () => {
    const { consumed } = startNode({ headers: { Authorization: "Bearer k" } });

    const res = makeRes(200);
    nodeMock.state.cb?.(res);
    res.emit("end");
    await consumed;

    const options = nodeMock.state.options as { headers: Record<string, unknown> };
    expect(options.headers).toMatchObject({
      "Content-Type": "application/json",
      Authorization: "Bearer k",
      "Content-Length": Buffer.byteLength("the-body"),
    });
  });

  it("throws the parsed error message on an HTTP error before the stream", async () => {
    const { consumed } = startNode();

    const res = makeRes(401);
    nodeMock.state.cb?.(res);
    res.emit("data", Buffer.from('{"error":{"message":"nope"}}'));
    res.emit("end");

    await expect(consumed).rejects.toThrow("HTTP 401: nope");
  });

  it("rejects on a request-level socket error", async () => {
    const { consumed } = startNode();

    // No response is ever delivered; the underlying request errors out.
    nodeMock.state.req?.emit("error", new Error("ECONNREFUSED"));

    await expect(consumed).rejects.toThrow("ECONNREFUSED");
  });

  it("throws immediately without making a request when the signal is already aborted", async () => {
    const controller = new AbortController();
    controller.abort();

    const { consumed } = startNode({ signal: controller.signal });

    await expect(consumed).rejects.toMatchObject({ name: "AbortError" });
    expect(nodeMock.state.cb).toBeNull(); // request was never issued
  });

  it("aborts an in-flight stream: destroys the request and throws AbortError", async () => {
    const controller = new AbortController();
    const { consumed } = startNode({ signal: controller.signal });

    const res = makeRes(200);
    nodeMock.state.cb?.(res);
    controller.abort();

    await expect(consumed).rejects.toMatchObject({ name: "AbortError" });
    expect(nodeMock.state.req?.destroyed).toBe(true);
  });

  it("throws the SSE error message on an in-stream error event", async () => {
    const { consumed } = startNode();

    const res = makeRes(200);
    nodeMock.state.cb?.(res);
    res.emit("data", Buffer.from('data: {"error":{"message":"Server overloaded"}}\n'));
    res.emit("end");

    await expect(consumed).rejects.toThrow("Server overloaded");
  });
});
