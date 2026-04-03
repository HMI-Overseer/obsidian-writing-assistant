import type { EmbeddingClient, EmbeddingResult } from "./embeddingClient";
import { request } from "../api/httpTransport";

interface OpenAIEmbeddingResponse {
  data: Array<{ embedding: number[]; index: number }>;
  usage?: { total_tokens?: number };
}

/**
 * OpenAI-compatible embedding client.
 * Works with LM Studio and OpenAI `/v1/embeddings` endpoints.
 */
export class LMStudioEmbeddingClient implements EmbeddingClient {
  constructor(
    private readonly baseUrl: string,
    private readonly bypassCors: boolean = true,
    private readonly headers?: Record<string, string>,
  ) {}

  async embed(
    texts: string[],
    model: string,
    signal?: AbortSignal,
  ): Promise<EmbeddingResult> {
    if (texts.length === 0) {
      return { vectors: [], dimensions: 0 };
    }

    const body = JSON.stringify({ input: texts, model });

    const raw = await request(
      "POST",
      this.baseUrl,
      "/embeddings",
      this.bypassCors,
      body,
      signal,
    );

    const json = JSON.parse(raw) as OpenAIEmbeddingResponse;

    if (!Array.isArray(json.data) || json.data.length === 0) {
      throw new Error("Embedding response contained no data.");
    }

    // Sort by index to match input order.
    const sorted = [...json.data].sort((a, b) => a.index - b.index);
    const vectors = sorted.map((item) => item.embedding);
    const dimensions = vectors[0].length;

    const result: EmbeddingResult = { vectors, dimensions };

    if (typeof json.usage?.total_tokens === "number") {
      result.usage = { totalTokens: json.usage.total_tokens };
    }

    return result;
  }
}
