import { describe, expect, it, vi } from "vitest";
import {
  createLMStudioLabSubject,
  LMStudioPreflightError,
  preflightLMStudioLabSubject,
  readLMStudioLabConfig,
  type LMStudioDiscoveryClient,
} from "../../../experimental/local/lmStudio";
import type { LMStudioModelListResult } from "../../../src/api/types";

function discoveryClient(
  listModelsWithSource: LMStudioDiscoveryClient["listModelsWithSource"],
): LMStudioDiscoveryClient {
  return {
    getResolvedBaseUrl: () => "http://localhost:1234/v1",
    listModelsWithSource,
    complete: vi.fn(async () => ({ text: "", usage: null })),
    stream: vi.fn(() => {
      throw new Error("Streaming is not used by preflight.");
    }),
  };
}

function discoveryResult(): LMStudioModelListResult {
  return {
    source: "native",
    endpoint: "http://localhost:1234/api/v1/models",
    models: [
      {
        id: "local/model",
        key: "local/model",
        displayName: "Local Model",
        state: "loaded",
        isLoaded: true,
        architecture: "test-architecture",
        quantization: { name: "Q5_K_M", bitsPerWeight: 5.5 },
        paramsString: "8B",
        sizeBytes: 5_000,
        loadedInstances: [{ id: "instance-1", config: { contextLength: 8_192 } }],
        maxContextLength: 32_768,
        format: "gguf",
        capabilities: { trainedForToolUse: true, vision: false },
      },
    ],
  };
}

describe("readLMStudioLabConfig", () => {
  it("builds an explicit reproducible local subject configuration", () => {
    const config = readLMStudioLabConfig({
      LAB_MODEL_ID: "local/model",
      LAB_LMSTUDIO_URL: "http://localhost:1234/v1/",
      LAB_LMSTUDIO_BYPASS_CORS: "false",
      LAB_SOURCE_REVISION: "revision-1",
      LAB_MODEL_ARTIFACT: "model.gguf",
      LAB_MODEL_QUANTIZATION: "Q4_K_M",
      LAB_INFERENCE_ENGINE_VERSION: "LM Studio 0.4",
      LAB_CHAT_TEMPLATE: "model-default",
    });

    expect(config).toEqual({
      endpoint: "http://localhost:1234/v1",
      bypassCors: false,
      modelId: "local/model",
      sourceRevision: "revision-1",
      runtime: {
        artifact: "model.gguf",
        quantization: "Q4_K_M",
        inferenceEngineVersion: "LM Studio 0.4",
        chatTemplate: "model-default",
      },
    });

    const subject = createLMStudioLabSubject(config);
    expect(subject.provenance).toMatchObject({
      sourceRevision: "revision-1",
      subject: {
        provider: "lmstudio",
        modelId: "local/model",
        endpoint: "http://localhost:1234/v1",
        runtime: { bypassCors: false, quantization: "Q4_K_M" },
      },
    });
  });

  it("requires a model identifier", () => {
    expect(() => readLMStudioLabConfig({})).toThrow("LAB_MODEL_ID is required");
  });

  it("rejects non-loopback endpoints in Phase 2", () => {
    expect(() => readLMStudioLabConfig({
      LAB_MODEL_ID: "model",
      LAB_LMSTUDIO_URL: "https://models.example.com/v1",
    })).toThrow("only permits a loopback");
  });

  it("rejects ambiguous boolean configuration", () => {
    expect(() => readLMStudioLabConfig({
      LAB_MODEL_ID: "model",
      LAB_LMSTUDIO_BYPASS_CORS: "yes",
    })).toThrow("must be true or false");
  });

  it("preflights the endpoint and records discovered model metadata", async () => {
    const config = readLMStudioLabConfig({ LAB_MODEL_ID: "local/model" });
    const result = await preflightLMStudioLabSubject(
      config,
      undefined,
      discoveryClient(async () => discoveryResult()),
    );

    expect(result.discovery).toMatchObject({
      source: "native",
      modelCount: 1,
      selectedModel: { id: "local/model", isLoaded: true },
    });
    expect(result.provenance.subject.runtime).toMatchObject({
      discoverySource: "native",
      architecture: "test-architecture",
      quantization: "Q5_K_M",
      bitsPerWeight: 5.5,
      parameters: "8B",
      maxContextLength: 32_768,
      trainedForToolUse: true,
      loadedInstanceIds: "instance-1",
      activeContextLength: 8_192,
    });
  });

  it("distinguishes endpoint failure from model unavailability", async () => {
    const config = readLMStudioLabConfig({ LAB_MODEL_ID: "missing/model" });
    const endpointFailure = preflightLMStudioLabSubject(
      config,
      undefined,
      discoveryClient(async () => {
        throw new Error("connection refused");
      }),
    );
    await expect(endpointFailure).rejects.toMatchObject({
      name: "LMStudioPreflightError",
      kind: "endpoint-unavailable",
    });

    const missingModel = preflightLMStudioLabSubject(
      config,
      undefined,
      discoveryClient(async () => discoveryResult()),
    );
    await expect(missingModel).rejects.toBeInstanceOf(LMStudioPreflightError);
    await expect(missingModel).rejects.toMatchObject({ kind: "model-unavailable" });
  });
});
