import { describe, test, expect } from "vitest";
import { parseToolArguments } from "../../../src/api/parsing";

describe("parseToolArguments", () => {
  test("parses a well-formed JSON object", () => {
    expect(parseToolArguments('{"path":"a.md","search":"x"}')).toEqual({
      path: "a.md",
      search: "x",
    });
  });

  test("returns {} for an empty string (a no-arg tool call)", () => {
    // A no-arg call may stream empty arguments; that is not malformed.
    expect(parseToolArguments("")).toEqual({});
  });

  test("returns {} for undefined", () => {
    expect(parseToolArguments(undefined)).toEqual({});
  });

  test("returns {} for malformed JSON instead of throwing", () => {
    // The call is surfaced with empty args so the loop returns a self-correcting
    // validation error on its timeline step, rather than dropping the call.
    expect(parseToolArguments('{"path": "a.md", "search":')).toEqual({});
  });

  test("returns {} for valid JSON that is not an object", () => {
    expect(parseToolArguments('"hello"')).toEqual({});
    expect(parseToolArguments("42")).toEqual({});
    expect(parseToolArguments("null")).toEqual({});
    expect(parseToolArguments('["a","b"]')).toEqual({});
  });
});
