import { hashTextToVector, normalizeVector } from "@alphabook/corpus-text";

import { openAIUsageFromResponse, type BillingContext, type BillingService } from "./billing";

export interface Embedder {
  embedQuery(text: string, billingContext?: BillingContext): Promise<number[]>;
}

type FetchLike = typeof fetch;

export class HashEmbedder implements Embedder {
  async embedQuery(text: string): Promise<number[]> {
    return hashTextToVector(text);
  }
}

export class OpenAIEmbedder implements Embedder {
  constructor(
    private readonly apiKey: string,
    private readonly model: string,
    private readonly fetchImpl: FetchLike = (input, init) => fetch(input, init),
    private readonly billing?: BillingService,
  ) {}

  async embedQuery(text: string, billingContext?: BillingContext): Promise<number[]> {
    const body: Record<string, unknown> = {
      model: this.model,
      input: text,
    };
    if (this.model.startsWith("text-embedding-3-")) {
      body.dimensions = 1536;
    }

    const response = await this.fetchImpl("https://api.openai.com/v1/embeddings", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify(body),
    });
    if (!response.ok) {
      const detail = await response.text();
      throw new Error(`Embedding request failed: ${detail}`);
    }

    const payload = (await response.json()) as {
      data?: Array<{
        embedding?: number[];
      }>;
      usage?: Record<string, unknown>;
      id?: string;
    };
    if (this.billing && billingContext) {
      const usage = openAIUsageFromResponse(payload as Record<string, unknown>);
      if (usage) {
        await this.billing.track(billingContext, {
          provider: "openai",
          model: this.model,
          operation: "embeddings.create",
          ...usage,
          requestId: payload.id ?? null,
          requestJson: body,
          responseJson: {
            usage: payload.usage ?? null,
          },
          metadata: {
            inputLength: text.length,
          },
        });
      }
    }
    const embedding = payload.data?.[0]?.embedding;
    if (!embedding?.length) {
      throw new Error("Embedding response was empty.");
    }
    return embedding;
  }
}

export class GoogleAIEmbedder implements Embedder {
  constructor(
    private readonly apiKey: string,
    private readonly model: string = "gemini-embedding-2-preview",
    private readonly outputDimensionality: number = 1536,
    private readonly fetchImpl: FetchLike = (input, init) => fetch(input, init),
  ) {}

  async embedQuery(text: string): Promise<number[]> {
    const body = {
      model: `models/${this.model}`,
      content: {
        parts: [{ text }],
      },
      output_dimensionality: this.outputDimensionality,
    };

    const response = await this.fetchImpl(
      `https://generativelanguage.googleapis.com/v1beta/models/${this.model}:embedContent`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-goog-api-key": this.apiKey,
        },
        body: JSON.stringify(body),
      },
    );
    if (!response.ok) {
      const detail = await response.text();
      throw new Error(`Google embedding request failed: ${detail}`);
    }

    const payload = (await response.json()) as {
      embedding?: {
        values?: number[];
      };
    };
    const embedding = payload.embedding?.values;
    if (!embedding?.length) {
      throw new Error("Google embedding response was empty.");
    }
    return normalizeVector(embedding);
  }
}
