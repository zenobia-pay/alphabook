import { GetObjectCommand, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";

import type { BlobObject, BlobStore } from "./r2";

async function bodyToUint8Array(body: unknown): Promise<Uint8Array> {
  if (!body) {
    return new Uint8Array();
  }
  if (typeof (body as { transformToByteArray?: () => Promise<Uint8Array> }).transformToByteArray === "function") {
    return await (body as { transformToByteArray: () => Promise<Uint8Array> }).transformToByteArray();
  }
  const chunks: Uint8Array[] = [];
  for await (const chunk of body as AsyncIterable<Uint8Array | string>) {
    chunks.push(typeof chunk === "string" ? new TextEncoder().encode(chunk) : chunk);
  }
  const length = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
  const output = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    output.set(chunk, offset);
    offset += chunk.length;
  }
  return output;
}

export type S3BlobStoreOptions = {
  bucketName: string;
  endpoint?: string;
  region?: string;
  accessKeyId: string;
  secretAccessKey: string;
  forcePathStyle?: boolean;
};

export class S3BlobStore implements BlobStore {
  private readonly client: S3Client;

  constructor(
    private readonly options: S3BlobStoreOptions,
    client?: S3Client,
  ) {
    this.client = client ?? new S3Client({
      endpoint: options.endpoint,
      region: options.region ?? "us-east-1",
      forcePathStyle: options.forcePathStyle ?? false,
      credentials: {
        accessKeyId: options.accessKeyId,
        secretAccessKey: options.secretAccessKey,
      },
    });
  }

  async getText(key: string): Promise<string | null> {
    const object = await this.getObject(key);
    return object ? await object.text() : null;
  }

  async getObject(key: string): Promise<BlobObject | null> {
    try {
      const response = await this.client.send(new GetObjectCommand({
        Bucket: this.options.bucketName,
        Key: key,
      }));
      if (!response.Body) {
        return null;
      }
      const bytes = await bodyToUint8Array(response.Body);
      const decoder = new TextDecoder();
      return {
        key,
        contentType: response.ContentType ?? null,
        arrayBuffer: async () => Uint8Array.from(bytes).buffer,
        text: async () => decoder.decode(bytes),
      };
    } catch (error) {
      const details = error as { $metadata?: { httpStatusCode?: number } };
      if (details.$metadata?.httpStatusCode === 404) {
        return null;
      }
      throw error;
    }
  }

  async putText(key: string, value: string, contentType = "text/plain; charset=utf-8"): Promise<void> {
    await this.client.send(new PutObjectCommand({
      Bucket: this.options.bucketName,
      Key: key,
      Body: value,
      ContentType: contentType,
    }));
  }

  async putJson(key: string, value: unknown): Promise<void> {
    await this.putText(key, JSON.stringify(value, null, 2), "application/json; charset=utf-8");
  }
}
