export interface BlobObject {
  key: string;
  contentType: string | null;
  arrayBuffer(): Promise<ArrayBuffer>;
  text(): Promise<string>;
}

export interface BlobStore {
  getText(key: string): Promise<string | null>;
  getObject(key: string): Promise<BlobObject | null>;
  putText(key: string, value: string, contentType?: string): Promise<void>;
  putJson(key: string, value: unknown): Promise<void>;
}

export class CloudflareR2Store implements BlobStore {
  constructor(private readonly bucket: R2Bucket) {}

  async getText(key: string): Promise<string | null> {
    const object = await this.bucket.get(key);
    if (!object) {
      return null;
    }
    return object.text();
  }

  async getObject(key: string): Promise<BlobObject | null> {
    const object = await this.bucket.get(key);
    if (!object) {
      return null;
    }
    return {
      key,
      contentType: object.httpMetadata?.contentType ?? null,
      arrayBuffer: () => object.arrayBuffer(),
      text: () => object.text(),
    };
  }

  async putText(key: string, value: string, contentType = "text/plain; charset=utf-8"): Promise<void> {
    await this.bucket.put(key, value, {
      httpMetadata: {
        contentType,
      },
    });
  }

  async putJson(key: string, value: unknown): Promise<void> {
    await this.putText(key, JSON.stringify(value, null, 2), "application/json; charset=utf-8");
  }
}

export class MemoryBlobStore implements BlobStore {
  private readonly blobs = new Map<string, string>();

  seed(key: string, value: string): void {
    this.blobs.set(key, value);
  }

  async getText(key: string): Promise<string | null> {
    return this.blobs.get(key) ?? null;
  }

  async getObject(key: string): Promise<BlobObject | null> {
    const value = this.blobs.get(key);
    if (value == null) {
      return null;
    }
    return {
      key,
      contentType: "text/plain; charset=utf-8",
      arrayBuffer: async () => new TextEncoder().encode(value).buffer,
      text: async () => value,
    };
  }

  async putText(key: string, value: string): Promise<void> {
    this.blobs.set(key, value);
  }

  async putJson(key: string, value: unknown): Promise<void> {
    await this.putText(key, JSON.stringify(value, null, 2));
  }
}
