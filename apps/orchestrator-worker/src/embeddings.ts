import { hashTextToVector } from "@alphabook/shared";

export interface Embedder {
  embedQuery(text: string): Promise<number[]>;
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
  ) {}

  async embedQuery(text: string): Promise<number[]> {
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
    };
    const embedding = payload.data?.[0]?.embedding;
    if (!embedding?.length) {
      throw new Error("Embedding response was empty.");
    }
    return embedding;
  }
}
