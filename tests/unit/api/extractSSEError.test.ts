import { describe, it, expect } from "vitest";
import { extractSSEError } from "../../../src/api/streamingTransport";

describe("extractSSEError", () => {
  it("returns null for normal delta events", () => {
    expect(extractSSEError({ choices: [{ delta: { content: "hello" } }] })).toBeNull();
  });

  it("returns null for events without an error field", () => {
    expect(extractSSEError({})).toBeNull();
    expect(extractSSEError({ id: "123" })).toBeNull();
  });

  it("extracts message from object error (OpenAI format)", () => {
    const event = {
      error: { message: "Rate limit exceeded", type: "rate_limit_error", code: 429 },
    };
    expect(extractSSEError(event)).toBe("Rate limit exceeded");
  });

  it("extracts message from string error", () => {
    expect(extractSSEError({ error: "Something went wrong" })).toBe("Something went wrong");
  });

  it("extracts message from LM Studio context overflow error", () => {
    const event = {
      error: {
        message:
          "The number of tokens to keep from the initial prompt is greater than the context length",
        type: "invalid_request_error",
        code: 400,
      },
    };
    expect(extractSSEError(event)).toBe(
      "The number of tokens to keep from the initial prompt is greater than the context length"
    );
  });

  it("returns fallback for object error without message", () => {
    expect(extractSSEError({ error: { code: 500 } })).toBe("Unknown streaming error");
  });

  it("returns null when error is falsy", () => {
    expect(extractSSEError({ error: null })).toBeNull();
    expect(extractSSEError({ error: 0 })).toBeNull();
    expect(extractSSEError({ error: "" })).toBeNull();
    expect(extractSSEError({ error: false })).toBeNull();
  });
});
