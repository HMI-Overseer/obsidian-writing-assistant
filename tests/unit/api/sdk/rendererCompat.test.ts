import { describe, it, expect } from "vitest";
import { ensureAbortSignalNodeCompatible } from "../../../../src/api/sdk/rendererCompat";

/**
 * A probe modelling Node's `events.setMaxListeners(n, target)`: it accepts a real
 * Node EventTarget, but a Blink AbortSignal (no Node brand) is accepted only once
 * it exposes its own `setMaxListeners` method, otherwise it throws the same
 * TypeError Obsidian's renderer surfaces.
 */
function nodeLikeProbe(isNodeTarget: boolean): (signal: AbortSignal) => void {
  return (signal) => {
    const hasMethod = typeof (signal as { setMaxListeners?: unknown }).setMaxListeners === "function";
    if (!isNodeTarget && !hasMethod) {
      throw new TypeError(
        'The "eventTargets" argument must be an instance of EventEmitter or EventTarget. ' +
          "Received an instance of AbortSignal",
      );
    }
  };
}

/** A Blink-like signal: a plain object on a fresh prototype, no Node EventTarget brand. */
function blinkSignal(): { signal: AbortSignal; proto: { setMaxListeners?: unknown } } {
  const proto: { setMaxListeners?: unknown } = {};
  const signal = Object.create(proto) as AbortSignal;
  return { signal, proto };
}

describe("ensureAbortSignalNodeCompatible (Electron renderer realm shim)", () => {
  it("adds a no-op setMaxListeners so a rejected Blink signal becomes acceptable", () => {
    const { signal, proto } = blinkSignal();
    const probe = nodeLikeProbe(false);

    // Precondition: Node rejects it as shipped.
    expect(() => probe(signal)).toThrow(/eventTargets/);

    const patched = ensureAbortSignalNodeCompatible(signal, probe);

    expect(patched).toBe(true);
    expect(typeof proto.setMaxListeners).toBe("function");
    // The very call that crashed query() now passes.
    expect(() => probe(signal)).not.toThrow();
  });

  it("defines setMaxListeners as a non-enumerable prototype method", () => {
    const { signal, proto } = blinkSignal();
    ensureAbortSignalNodeCompatible(signal, nodeLikeProbe(false));

    const descriptor = Object.getOwnPropertyDescriptor(proto, "setMaxListeners");
    expect(descriptor?.enumerable).toBe(false);
    expect(descriptor?.configurable).toBe(true);
  });

  it("leaves a signal Node already accepts untouched", () => {
    const { signal, proto } = blinkSignal();
    const patched = ensureAbortSignalNodeCompatible(signal, nodeLikeProbe(true));

    expect(patched).toBe(false);
    expect(proto.setMaxListeners).toBeUndefined();
  });

  it("is idempotent: a second call is a no-op once the method exists", () => {
    const { signal, proto } = blinkSignal();
    const probe = nodeLikeProbe(false);

    expect(ensureAbortSignalNodeCompatible(signal, probe)).toBe(true);
    const first = proto.setMaxListeners;
    // The probe no longer throws (method present), so nothing is re-applied.
    expect(ensureAbortSignalNodeCompatible(signal, probe)).toBe(false);
    expect(proto.setMaxListeners).toBe(first);
  });
});
