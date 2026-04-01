interface QdrantCollectionInfoResult {
  config?: {
    params?: {
      vectors?: {
        size?: number;
      };
    };
  };
  points_count?: number;
}

interface QdrantPointRecord {
  id?: string | number;
}

interface QdrantScrollResult {
  points?: QdrantPointRecord[];
  next_page_offset?: string | number | null;
}

type QdrantPointInput = {
  id: string;
  values: number[];
  metadata?: Record<string, unknown>;
};

function normalizePointId(id: string | number | undefined) {
  if (typeof id === "string" || typeof id === "number") {
    return String(id);
  }
  return null;
}

export class QdrantApi {
  constructor(
    private readonly baseUrl: string,
    private readonly collection: string,
    private readonly apiKey?: string,
    private readonly timeoutMs = 30_000,
    private readonly fetchImpl: typeof fetch = (input, init) => fetch(input, init),
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
    if (!response.ok) {
      const detail = await response.text();
      throw new Error(`${label} failed: ${response.status} ${detail}`);
    }
    const payload = await response.json() as { result?: T };
    return payload.result as T;
  }

  async getInfo(): Promise<{ dimensions?: number; vectorCount?: number }> {
    const result = await this.request<QdrantCollectionInfoResult>(
      `collections/${encodeURIComponent(this.collection)}`,
      { method: "GET" },
      "Qdrant collection info",
    );
    return {
      dimensions: result.config?.params?.vectors?.size,
      vectorCount: result.points_count,
    };
  }

  async upsert(points: QdrantPointInput[]): Promise<void> {
    if (points.length === 0) {
      return;
    }
    await this.request(
      `collections/${encodeURIComponent(this.collection)}/points?wait=true`,
      {
        method: "PUT",
        body: JSON.stringify({
          points: points.map((point) => ({
            id: point.id,
            vector: point.values,
            ...(point.metadata ? { payload: point.metadata } : {}),
          })),
        }),
      },
      "Qdrant upsert",
    );
  }

  async getVectorIds(ids: string[]): Promise<Set<string>> {
    if (ids.length === 0) {
      return new Set<string>();
    }
    const found = new Set<string>();
    for (let index = 0; index < ids.length; index += 256) {
      const batch = ids.slice(index, index + 256);
      const result = await this.request<QdrantPointRecord[]>(
        `collections/${encodeURIComponent(this.collection)}/points`,
        {
          method: "POST",
          body: JSON.stringify({
            ids: batch,
            with_payload: false,
            with_vector: false,
          }),
        },
        "Qdrant point lookup",
      );
      for (const point of result) {
        const id = normalizePointId(point.id);
        if (id) {
          found.add(id);
        }
      }
    }
    return found;
  }

  async listVectorIds(): Promise<string[]> {
    const ids: string[] = [];
    let offset: string | number | null = null;
    while (true) {
      const result: QdrantScrollResult = await this.request<QdrantScrollResult>(
        `collections/${encodeURIComponent(this.collection)}/points/scroll`,
        {
          method: "POST",
          body: JSON.stringify({
            limit: 1000,
            with_payload: false,
            with_vector: false,
            ...(offset !== null ? { offset } : {}),
          }),
        },
        "Qdrant scroll",
      );
      for (const point of result.points ?? []) {
        const id = normalizePointId(point.id);
        if (id) {
          ids.push(id);
        }
      }
      if (result.next_page_offset === null || result.next_page_offset === undefined) {
        break;
      }
      offset = result.next_page_offset;
    }
    return ids;
  }

  async deleteVectorIds(ids: string[]): Promise<void> {
    for (let index = 0; index < ids.length; index += 1000) {
      const batch = ids.slice(index, index + 1000);
      if (batch.length === 0) {
        continue;
      }
      await this.request(
        `collections/${encodeURIComponent(this.collection)}/points/delete?wait=true`,
        {
          method: "POST",
          body: JSON.stringify({
            points: batch,
          }),
        },
        "Qdrant delete",
      );
    }
  }
}
