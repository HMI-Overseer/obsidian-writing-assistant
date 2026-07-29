import { describe, expect, it } from "vitest";
import { memoryDispositionMessage } from "../../../../src/tools/memory/disposition";
import type { MemoryMutation } from "../../../../src/tools/memory/handlers";

const ADD: MemoryMutation = {
  kind: "add",
  memory: {
    name: "Alice speaks in short sentences",
    type: "character",
    description: "Voice note",
    enabled: true,
  },
};

const FORGET: MemoryMutation = {
  kind: "forget",
  name: "Alice speaks in short sentences",
};

const BASE_DECLINE =
  'Declined by user, memory "Alice speaks in short sentences" was not changed.';

describe("memoryDispositionMessage", () => {
  it("reports the applied, auto-applied, and failed outcomes in memory terms", () => {
    expect(memoryDispositionMessage(ADD, "applied")).toBe(
      'Added memory "Alice speaks in short sentences".',
    );
    expect(memoryDispositionMessage(FORGET, "applied")).toBe(
      'Forgot memory "Alice speaks in short sentences".',
    );
    expect(memoryDispositionMessage(ADD, "auto-applied")).toBe(
      'Added memory "Alice speaks in short sentences" (auto-applied).',
    );
    expect(memoryDispositionMessage(FORGET, "failed", "the memory no longer exists")).toBe(
      'Error: could not forget memory "Alice speaks in short sentences", the memory no longer exists.',
    );
  });
});

// RFC-0012: the memory channel's half of the decline-guidance contract.
describe("memory decline guidance", () => {
  it("stays byte-identical for absent, empty, and whitespace-only guidance", () => {
    expect(memoryDispositionMessage(ADD, "declined")).toBe(BASE_DECLINE);
    expect(memoryDispositionMessage(ADD, "declined", undefined, "")).toBe(BASE_DECLINE);
    expect(memoryDispositionMessage(ADD, "declined", undefined, " \n\t")).toBe(BASE_DECLINE);
  });

  it("appends the guidance as one distinct trailing sentence", () => {
    expect(
      memoryDispositionMessage(ADD, "declined", undefined, "that is a scene note, not a voice note"),
    ).toBe(`${BASE_DECLINE} The user's guidance: that is a scene note, not a voice note.`);
  });

  it("ignores guidance on every non-declined disposition", () => {
    const guidance = "not a decline";
    expect(memoryDispositionMessage(ADD, "applied", undefined, guidance)).toBe(
      'Added memory "Alice speaks in short sentences".',
    );
    expect(memoryDispositionMessage(ADD, "failed", "disk full", guidance)).toBe(
      'Error: could not add memory "Alice speaks in short sentences", disk full.',
    );
    expect(memoryDispositionMessage(ADD, "cancelled", undefined, guidance)).toBe(
      'Generation stopped before you decided, memory proposal "Alice speaks in short sentences" was cancelled and discarded.',
    );
    expect(memoryDispositionMessage(ADD, "satisfied", undefined, guidance)).toBe(
      'Memory "Alice speaks in short sentences" already satisfies the proposal; nothing to change.',
    );
  });
});
