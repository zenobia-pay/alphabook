interface CloudflareEnvelope<T> {
  success: boolean;
  errors?: Array<{ code: number; message: string }>;
  messages?: Array<{ code: number; message: string }>;
  result: T;
}

interface VectorizeInfoResult {
  dimensions?: number;
  vectorCount?: number;
}

interface VectorizeListResult {
  vectors?: Array<{ id: string }>;
  nextCursor?: string;
  isTruncated?: boolean;
  totalCount?: number;
}

interface VectorizeGetResult {
  vectors?: Array<{ id: string }>;
}

export class CloudflareVectorizeApi {
  constructor(
    private readonly accountId: string,
    private readonly apiToken: string,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  private async request<T>(path: string, init?: RequestInit): Promise<T> {
    const response = await this.fetchImpl(`https://api.cloudflare.com/client/v4/accounts/${this.accountId}${path}`, {
      ...init,
      headers: {
        authorization: `Bearer ${this.apiToken}`,
        "content-type": "application/json",
        ...(init?.headers ?? {}),
      },
    });
    const payload = await response.json() as CloudflareEnvelope<T>;
    if (!response.ok || !payload.success) {
      const details = payload.errors?.map((error) => `${error.code}: ${error.message}`).join("; ")
        ?? `${response.status} ${response.statusText}`;
      throw new Error(`Cloudflare Vectorize request failed: ${details}`);
    }
    return payload.result;
  }

  async getInfo(indexName: string): Promise<VectorizeInfoResult> {
    return await this.request<VectorizeInfoResult>(`/vectorize/v2/indexes/${indexName}`);
  }

  async listVectorIds(indexName: string): Promise<string[]> {
    const ids: string[] = [];
    let cursor: string | null = null;
    while (true) {
      const query = new URLSearchParams();
      query.set("count", "1000");
      if (cursor) {
        query.set("cursor", cursor);
      }
      const result = await this.request<VectorizeListResult>(`/vectorize/v2/indexes/${indexName}/list?${query.toString()}`);
      ids.push(...(result.vectors ?? []).map((vector) => vector.id));
      if (!result.isTruncated || !result.nextCursor) {
        break;
      }
      cursor = result.nextCursor;
    }
    return ids;
  }

  async getVectorIds(indexName: string, ids: string[]): Promise<Set<string>> {
    const found = new Set<string>();
    for (let index = 0; index < ids.length; index += 100) {
      const batch = ids.slice(index, index + 100);
      if (batch.length === 0) {
        continue;
      }
      const query = new URLSearchParams();
      for (const id of batch) {
        query.append("ids", id);
      }
      const result = await this.request<VectorizeGetResult>(`/vectorize/v2/indexes/${indexName}/get_by_ids?${query.toString()}`);
      for (const vector of result.vectors ?? []) {
        if (vector.id) {
          found.add(vector.id);
        }
      }
    }
    return found;
  }

  async deleteVectorIds(indexName: string, ids: string[]): Promise<void> {
    for (let index = 0; index < ids.length; index += 100) {
      const batch = ids.slice(index, index + 100);
      if (batch.length === 0) {
        continue;
      }
      await this.request(`/vectorize/v2/indexes/${indexName}/delete_by_ids`, {
        method: "POST",
        body: JSON.stringify({ ids: batch }),
      });
    }
  }
}
