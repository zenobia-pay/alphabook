export interface BlobObject {
  key: string;
  text(): Promise<string>;
}

export interface BlobStore {
  getText(key: string): Promise<string | null>;
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

  async putText(key: string, value: string): Promise<void> {
    this.blobs.set(key, value);
  }

  async putJson(key: string, value: unknown): Promise<void> {
    await this.putText(key, JSON.stringify(value, null, 2));
  }
}
