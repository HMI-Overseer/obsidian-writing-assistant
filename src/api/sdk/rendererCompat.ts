import { setMaxListeners } from "events";

/**
 * Electron renderer ⇄ Node realm shim for `AbortSignal`.
 *
 * Obsidian runs in Electron's renderer, where the global `AbortController` /
 * `AbortSignal` are Blink's DOM implementations, not Node's. The Claude Agent
 * SDK's `query()` setup immediately builds an `AbortController` and hands its
 * signal to Node's `events.setMaxListeners(n, signal)`. Node rejects a Blink
 * signal, it lacks Node's internal EventTarget brand, throwing
 *
 *   The "eventTargets" argument must be an instance of EventEmitter or
 *   EventTarget. Received an instance of AbortSignal
 *
 * before the first turn can stream. Node's `events.setMaxListeners` also accepts
 * any object that exposes its own `setMaxListeners`, so we add a no-op to the DOM
 * `AbortSignal` prototype. Nothing else reads that method, so Blink signals pass
 * through Node untouched, and because the patch lives on the shared prototype it
 * covers the controllers the SDK builds internally too (we never see them).
 */

/** Probes whether Node's events module accepts `signal`; throws in the renderer. */
function defaultProbe(signal: AbortSignal): void {
  setMaxListeners(0, signal);
}

/**
 * Makes `signal` acceptable to Node's `events.setMaxListeners`. A no-op when Node
 * already accepts it (real Node, e.g. tests); in the Electron renderer it adds a
 * no-op `setMaxListeners` to the signal's prototype. Idempotent (the second call
 * sees the method already present and the probe stops throwing). `probe` is
 * injectable for tests. Returns true when a patch was applied.
 */
export function ensureAbortSignalNodeCompatible(
  signal: AbortSignal,
  probe: (signal: AbortSignal) => void = defaultProbe,
): boolean {
  try {
    probe(signal);
    return false; // Node already accepts this signal; nothing to do.
  } catch {
    // Renderer realm mismatch: Blink's AbortSignal isn't a Node EventTarget.
  }

  const proto = Object.getPrototypeOf(signal) as { setMaxListeners?: unknown };
  if (typeof proto.setMaxListeners === "function") return false;

  Object.defineProperty(proto, "setMaxListeners", {
    value(): void {
      // Node's events.setMaxListeners only requires this method to exist; Blink's
      // EventTarget has no per-target listener cap, so there is nothing to set.
    },
    writable: true,
    configurable: true,
    enumerable: false,
  });
  return true;
}

/**
 * Applies the shim once using the renderer's global `AbortController`. Called at
 * SDK load so the patch is in place before any `query()` builds a signal. Safe to
 * call repeatedly and a no-op outside the renderer.
 */
export function patchRendererAbortSignal(): void {
  try {
    ensureAbortSignalNodeCompatible(new AbortController().signal);
  } catch {
    // No usable AbortController in this environment; let the SDK surface any
    // resulting error itself rather than masking it here.
  }
}
