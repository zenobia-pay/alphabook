export interface VectorSearchMatch {
  id: string;
  score: number;
  metadata?: Record<string, unknown>;
}

export interface VectorSearchFilter {
  [key: string]: unknown;
}

export interface VectorSearchIndex {
  query(
    vector: number[],
    options?: {
      topK?: number;
      filter?: VectorSearchFilter;
      returnMetadata?: boolean;
    },
  ): Promise<VectorSearchMatch[]>;
  upsert(
    vectors: Array<{
      id: string;
      values: number[];
      metadata?: Record<string, unknown>;
    }>,
  ): Promise<void>;
}

export interface VectorizeBindingLike {
  query(
    vector: number[],
    options?: {
      topK?: number;
      filter?: VectorSearchFilter;
      returnMetadata?: boolean;
    },
  ): Promise<{
    matches?: Array<{
      id: string;
      score?: number;
      metadata?: Record<string, unknown>;
    }>;
  }>;
  upsert(
    vectors: Array<{
      id: string;
      values: number[];
      metadata?: Record<string, unknown>;
    }>,
  ): Promise<unknown>;
}

export class CloudflareVectorizeIndex implements VectorSearchIndex {
  constructor(private readonly binding: VectorizeBindingLike) {}

  async query(
    vector: number[],
    options: {
      topK?: number;
      filter?: VectorSearchFilter;
      returnMetadata?: boolean;
    } = {},
  ): Promise<VectorSearchMatch[]> {
    const result = await this.binding.query(vector, options);
    return (result.matches ?? []).map((match) => ({
      id: match.id,
      score: typeof match.score === "number" ? match.score : 0,
      metadata: match.metadata,
    }));
  }

  async upsert(
    vectors: Array<{
      id: string;
      values: number[];
      metadata?: Record<string, unknown>;
    }>,
  ) {
    await this.binding.upsert(vectors);
  }
}
