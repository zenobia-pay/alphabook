export interface VectorSearchMatch {
  id: string;
  score: number;
  metadata?: Record<string, unknown>;
}

export interface VectorSearchFilter {
  [key: string]: unknown;
}

type FetchLike = typeof fetch;

interface QdrantFilterClause {
  key: string;
  match?: { value: string | number | boolean | null };
}

interface QdrantPointResult {
  id?: string | number;
  score?: number;
  payload?: Record<string, unknown>;
}

const textEncoder = new TextEncoder();

function normalizePointId(id: string | number | undefined) {
  if (typeof id === "number" || typeof id === "string") {
    return String(id);
  }
  return "";
}

function sourceIdFromPayload(payload: Record<string, unknown> | undefined) {
  if (payload && typeof payload.source_id === "string" && payload.source_id.length > 0) {
    return payload.source_id;
  }
  return "";
}

function stripSourceIdFromPayload(payload: Record<string, unknown> | undefined) {
  if (!payload) {
    return undefined;
  }
  const metadata = { ...payload };
  delete metadata.source_id;
  return Object.keys(metadata).length > 0 ? metadata : undefined;
}

async function toQdrantPointId(id: string) {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-1", textEncoder.encode(id)));
  const bytes = Array.from(digest.slice(0, 16));
  bytes[6] = (bytes[6] & 0x0f) | 0x50;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = bytes.map((byte) => byte.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}

function toQdrantFilter(filter?: VectorSearchFilter) {
  if (!filter) {
    return undefined;
  }
  const must: QdrantFilterClause[] = [];
  for (const [key, value] of Object.entries(filter)) {
    if (
      value === null
      || typeof value === "string"
      || typeof value === "number"
      || typeof value === "boolean"
    ) {
      must.push({
        key,
        match: {
          value,
        },
      });
    }
  }
  return must.length > 0 ? { must } : undefined;
}

async function parseQdrantResponse<T>(response: Response, label: string): Promise<T> {
  if (!response.ok) {
    const detail = await response.text();
    throw new Error(`${label} failed: ${response.status} ${detail}`);
  }
  const payload = await response.json() as {
    result?: T;
    status?: string;
  };
  return payload.result as T;
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

export class QdrantVectorIndex implements VectorSearchIndex {
  constructor(
    private readonly baseUrl: string,
    private readonly collection: string,
    private readonly apiKey?: string,
    private readonly timeoutMs = 10_000,
    private readonly fetchImpl: FetchLike = (input, init) => fetch(input, init),
  ) {}

  private async request<T>(path: string, init: RequestInit, label: string): Promise<T> {
    const headers = new Headers(init.headers);
    headers.set("content-type", "application/json");
    if (this.apiKey) {
      headers.set("api-key", this.apiKey);
    }
    const response = await this.fetchImpl(
      new URL(path, this.baseUrl.endsWith("/") ? this.baseUrl : `${this.baseUrl}/`),
      {
        ...init,
        headers,
        signal: AbortSignal.timeout(this.timeoutMs),
      },
    );
    return parseQdrantResponse<T>(response, label);
  }

  async query(
    vector: number[],
    options: {
      topK?: number;
      filter?: VectorSearchFilter;
      returnMetadata?: boolean;
    } = {},
  ): Promise<VectorSearchMatch[]> {
    const result = await this.request<QdrantPointResult[]>(
      `collections/${encodeURIComponent(this.collection)}/points/search`,
      {
        method: "POST",
        body: JSON.stringify({
          vector,
          limit: Math.max(1, options.topK ?? 8),
          ...(toQdrantFilter(options.filter) ? { filter: toQdrantFilter(options.filter) } : {}),
          with_payload: options.returnMetadata ?? false,
          with_vector: false,
        }),
      },
      "Qdrant search",
    );
    return result
      .map((match) => ({
        id: sourceIdFromPayload(match.payload) || normalizePointId(match.id),
        score: typeof match.score === "number" ? match.score : 0,
        metadata: stripSourceIdFromPayload(match.payload),
      }))
      .filter((match) => match.id.length > 0);
  }

  async upsert(
    vectors: Array<{
      id: string;
      values: number[];
      metadata?: Record<string, unknown>;
    }>,
  ) {
    if (vectors.length === 0) {
      return;
    }
    const points = await Promise.all(vectors.map(async (vector) => ({
      id: await toQdrantPointId(vector.id),
      vector: vector.values,
      payload: {
        ...(vector.metadata ?? {}),
        source_id: vector.id,
      },
    })));
    await this.request<unknown>(
      `collections/${encodeURIComponent(this.collection)}/points?wait=true`,
      {
        method: "PUT",
        body: JSON.stringify({
          points,
        }),
      },
      "Qdrant upsert",
    );
  }
}
