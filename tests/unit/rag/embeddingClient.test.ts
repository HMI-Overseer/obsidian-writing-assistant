import { describe, test, expect } from "vitest";
import { assertEmbeddingVectors } from "../../../src/rag/embeddingClient";

describe("assertEmbeddingVectors", () => {
  test("accepts a well-formed response (one uniform vector per input)", () => {
    expect(() =>
      assertEmbeddingVectors(3, [
        [1, 2, 3],
        [4, 5, 6],
        [7, 8, 9],
      ]),
    ).not.toThrow();
  });

  test("throws an honest error when the response is truncated", () => {
    // 3 inputs but only 2 vectors came back — the case that used to store an
    // undefined vector for the third chunk.
    expect(() => assertEmbeddingVectors(3, [[1, 2, 3], [4, 5, 6]])).toThrow(
      /returned 2 vectors for 3 input/i,
    );
  });

  test("rejects an empty or missing vector even when the count matches", () => {
    expect(() => assertEmbeddingVectors(2, [[1, 2, 3], []])).toThrow(
      /empty or missing vector at index 1/i,
    );
  });

  test("rejects inconsistent vector dimensions", () => {
    expect(() => assertEmbeddingVectors(2, [[1, 2, 3], [4, 5]])).toThrow(
      /inconsistent vector dimensions/i,
    );
  });

  test("accepts the empty-input case (no vectors expected)", () => {
    expect(() => assertEmbeddingVectors(0, [])).not.toThrow();
  });
});
