import { describe, test, expect } from "vitest";
import type { CompletionModel, EmbeddingModel } from "../../../src/shared/types";
import {
  normalizeCompletionModel,
  normalizeEmbeddingModel,
} from "../../../src/shared/normalizeModels";

/**
 * Simulates a JSON round-trip through data.json — the model is serialized
 * then parsed back as a plain object with no type guarantees.
 */
function jsonRoundTrip<T>(obj: T): Record<string, unknown> {
  return JSON.parse(JSON.stringify(obj)) as Record<string, unknown>;
}

/** All keys that CompletionModel must carry after normalization. */
const COMPLETION_KEYS: (keyof CompletionModel)[] = ["id", "name", "modelId", "provider"];

/** All keys that EmbeddingModel must carry after normalization. */
const EMBEDDING_KEYS: (keyof EmbeddingModel)[] = ["id", "name", "modelId", "provider"];

describe("normalizeCompletionModel", () => {
  const SAVED_MODEL: CompletionModel = {
    id: "abc-123",
    name: "My Model",
    modelId: "llama-3",
    provider: "lmstudio",
  };

  test("preserves every field after a JSON round-trip (data.json reload)", () => {
    const fromDisk = jsonRoundTrip(SAVED_MODEL);
    const result = normalizeCompletionModel(fromDisk as Partial<CompletionModel>, 0);

    expect(result).toEqual(SAVED_MODEL);
  });

  test("output contains every key defined on CompletionModel", () => {
    const result = normalizeCompletionModel(SAVED_MODEL, 0);

    for (const key of COMPLETION_KEYS) {
      expect(result).toHaveProperty(key);
      expect(result[key]).toBeDefined();
    }
  });

  test("preserves id from saved data", () => {
    const result = normalizeCompletionModel({ id: "custom-id" }, 0);
    expect(result.id).toBe("custom-id");
  });

  test("preserves name from saved data", () => {
    const result = normalizeCompletionModel({ name: "Custom Name" }, 0);
    expect(result.name).toBe("Custom Name");
  });

  test("preserves modelId from saved data", () => {
    const result = normalizeCompletionModel({ modelId: "gpt-4o" }, 0);
    expect(result.modelId).toBe("gpt-4o");
  });

  test("preserves provider when set to openai", () => {
    const result = normalizeCompletionModel(
      { id: "x", name: "X", modelId: "m", provider: "openai" },
      0
    );
    expect(result.provider).toBe("openai");
  });

  test("preserves provider when set to anthropic", () => {
    const result = normalizeCompletionModel(
      { id: "x", name: "X", modelId: "m", provider: "anthropic" },
      0
    );
    expect(result.provider).toBe("anthropic");
  });

  test("defaults provider to lmstudio when missing", () => {
    const result = normalizeCompletionModel({ id: "x", name: "X", modelId: "m" }, 0);
    expect(result.provider).toBe("lmstudio");
  });

  test("defaults provider to lmstudio for null input", () => {
    expect(normalizeCompletionModel(null, 0).provider).toBe("lmstudio");
  });

  test("defaults provider to lmstudio for undefined input", () => {
    expect(normalizeCompletionModel(undefined, 0).provider).toBe("lmstudio");
  });

  test("generates fallback id and name from index", () => {
    const result = normalizeCompletionModel({}, 2);
    expect(result.id).toBe("model-3");
    expect(result.name).toBe("Model 3");
  });

  test("defaults modelId to empty string when missing", () => {
    expect(normalizeCompletionModel({}, 0).modelId).toBe("");
  });
});

describe("normalizeEmbeddingModel", () => {
  const SAVED_MODEL: EmbeddingModel = {
    id: "emb-456",
    name: "My Embedding",
    modelId: "nomic-embed",
    provider: "lmstudio",
  };

  test("preserves every field after a JSON round-trip (data.json reload)", () => {
    const fromDisk = jsonRoundTrip(SAVED_MODEL);
    const result = normalizeEmbeddingModel(fromDisk as Partial<EmbeddingModel>, 0);

    expect(result).toEqual(SAVED_MODEL);
  });

  test("output contains every key defined on EmbeddingModel", () => {
    const result = normalizeEmbeddingModel(SAVED_MODEL, 0);

    for (const key of EMBEDDING_KEYS) {
      expect(result).toHaveProperty(key);
      expect(result[key]).toBeDefined();
    }
  });

  test("preserves id from saved data", () => {
    const result = normalizeEmbeddingModel({ id: "emb-custom" }, 0);
    expect(result.id).toBe("emb-custom");
  });

  test("preserves name from saved data", () => {
    const result = normalizeEmbeddingModel({ name: "Custom Embedding" }, 0);
    expect(result.name).toBe("Custom Embedding");
  });

  test("preserves modelId from saved data", () => {
    const result = normalizeEmbeddingModel({ modelId: "bge-large" }, 0);
    expect(result.modelId).toBe("bge-large");
  });

  test("preserves provider when set to anthropic", () => {
    const result = normalizeEmbeddingModel(
      { id: "x", name: "X", modelId: "m", provider: "anthropic" },
      0
    );
    expect(result.provider).toBe("anthropic");
  });

  test("defaults provider to lmstudio when missing", () => {
    const result = normalizeEmbeddingModel({ id: "x", name: "X", modelId: "m" }, 0);
    expect(result.provider).toBe("lmstudio");
  });

  test("defaults provider to lmstudio for null input", () => {
    expect(normalizeEmbeddingModel(null, 0).provider).toBe("lmstudio");
  });

  test("generates fallback id and name from index", () => {
    const result = normalizeEmbeddingModel({}, 2);
    expect(result.id).toBe("embedding-3");
    expect(result.name).toBe("Embedding 3");
  });
});
