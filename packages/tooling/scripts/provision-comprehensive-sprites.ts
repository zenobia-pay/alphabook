import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

import { GetObjectCommand, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { createWranglerD1Db, loadLocalDevVars } from "@alphabook/db";
import { getImplementationConfig } from "@alphabook/implementations";

import { D1AppStore } from "../../../apps/orchestrator-worker/src/d1-store";
import { buildSpriteShardCatalog, MAX_SPRITE_SHARD_SIZE, type SpriteShardManifest } from "../../../apps/orchestrator-worker/src/sprite-fanout";
import { FlyMachinesRuntimeGateway } from "../../../apps/orchestrator-worker/src/runtime";
import type { BlobObject, BlobStore } from "../../../apps/orchestrator-worker/src/r2";

const DEFAULT_CONCURRENCY = 1;
const DEFAULT_EXPIRES_MINUTES = 15;
const DEFAULT_PROVISION_USER_ID = "sprite-provisioner";

class S3BlobStore implements BlobStore {
  constructor(
    private readonly client: S3Client,
    private readonly bucket: string,
  ) {}

  async getText(key: string): Promise<string | null> {
    const object = await this.getObject(key);
    return object ? object.text() : null;
  }

  async getObject(key: string): Promise<BlobObject | null> {
    try {
      const response = await this.client.send(new GetObjectCommand({
        Bucket: this.bucket,
        Key: key,
      }));
      if (!response.Body) {
        return null;
      }
      return {
        key,
        contentType: response.ContentType ?? null,
        arrayBuffer: async () => {
          const bytes = await response.Body!.transformToByteArray();
          return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
        },
        text: async () => response.Body!.transformToString(),
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (/NoSuchKey|The specified key does not exist|not found/iu.test(message)) {
        return null;
      }
      throw error;
    }
  }

  async putText(key: string, value: string, contentType = "text/plain; charset=utf-8"): Promise<void> {
    await this.client.send(new PutObjectCommand({
      Bucket: this.bucket,
      Key: key,
      Body: value,
      ContentType: contentType,
    }));
  }

  async putJson(key: string, value: unknown): Promise<void> {
    await this.putText(key, JSON.stringify(value, null, 2), "application/json; charset=utf-8");
  }
}

function readArg(name: string): string | null {
  const index = process.argv.indexOf(name);
  if (index === -1) {
    return null;
  }
  return process.argv[index + 1] ?? null;
}

function hasFlag(name: string): boolean {
  return process.argv.includes(name);
}

function parsePositiveInt(name: string, fallback: number): number {
  const raw = readArg(name);
  if (!raw) {
    return fallback;
  }
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`${name} must be a positive integer.`);
  }
  return parsed;
}

function formatShardSummary(shard: SpriteShardManifest): string {
  return `${shard.shardId} (${shard.bookCount} books)`;
}

async function mapWithConcurrency<T, R>(
  items: T[],
  concurrency: number,
  mapper: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let nextIndex = 0;

  const workers = Array.from({ length: Math.max(1, Math.min(concurrency, items.length || 1)) }, async () => {
    while (true) {
      const index = nextIndex;
      nextIndex += 1;
      if (index >= items.length) {
        return;
      }
      results[index] = await mapper(items[index]!, index);
    }
  });

  await Promise.all(workers);
  return results;
}

async function main() {
  await loadLocalDevVars(process.cwd());

  const implementationId = readArg("--implementation") ?? "alphabook";
  const implementation = getImplementationConfig(implementationId);
  const shardSize = parsePositiveInt("--shard-size", MAX_SPRITE_SHARD_SIZE);
  const startShard = Math.max(0, parsePositiveInt("--start-shard", 1) - 1);
  const maxShards = readArg("--max-shards") ? parsePositiveInt("--max-shards", 1) : null;
  const concurrency = parsePositiveInt("--concurrency", DEFAULT_CONCURRENCY);
  const expiresMinutes = parsePositiveInt("--expires-minutes", DEFAULT_EXPIRES_MINUTES);
  const requestedSessionId = readArg("--session-id");
  const dryRun = hasFlag("--dry-run");
  const cleanupStale = hasFlag("--cleanup-stale");
  const catalogFile = readArg("--catalog-file");

  const bucketName = process.env.R2_BUCKET_NAME;
  const endpoint = process.env.R2_ENDPOINT;
  const accessKeyId = process.env.R2_ACCESS_KEY_ID;
  const secretAccessKey = process.env.R2_SECRET_ACCESS_KEY;
  if (!bucketName || !endpoint || !accessKeyId || !secretAccessKey) {
    throw new Error("R2_BUCKET_NAME, R2_ENDPOINT, R2_ACCESS_KEY_ID, and R2_SECRET_ACCESS_KEY are required.");
  }
  const s3 = new S3Client({
    region: "auto",
    endpoint,
    credentials: {
      accessKeyId,
      secretAccessKey,
    },
  });
  const blobStore = new S3BlobStore(s3, bucketName);
  const store = new D1AppStore(createWranglerD1Db({
    cwd: process.cwd(),
    databaseName: process.env.D1_DATABASE_NAME ?? "alphabook-app",
    wranglerConfig: process.env.D1_WRANGLER_CONFIG ?? "apps/orchestrator-worker/wrangler.toml",
  }), {
    adapterId: implementation.adapterId,
    feedLabels: implementation.feedLabels,
    blobStore,
  });
  const provisionUserId = readArg("--user-id") ?? DEFAULT_PROVISION_USER_ID;
  await store.ensureUser(provisionUserId);
  const session = await store.createSession(
    provisionUserId,
    `Sprite provisioning for ${implementationId}${requestedSessionId ? ` (${requestedSessionId})` : ""}`,
  );
  const sessionId = session.id;

  const catalog = await buildSpriteShardCatalog(store, blobStore, implementationId, {
    shardSize,
  });
  const selectedShards = catalog.shards.slice(startShard, maxShards == null ? undefined : startShard + maxShards);

  if (catalogFile) {
    const absolute = resolve(catalogFile);
    await mkdir(dirname(absolute), { recursive: true });
    await writeFile(absolute, `${JSON.stringify(catalog, null, 2)}\n`, "utf8");
  }

  process.stdout.write(
    [
      `Implementation: ${implementationId}`,
      `Session: ${sessionId}`,
      `Total books: ${catalog.shards.reduce((sum, shard) => sum + shard.bookCount, 0)}`,
      `Shard size: ${catalog.shardSize}`,
      `Shard count: ${catalog.shardCount}`,
      `Selected shards: ${selectedShards.length}`,
      `Selected range: ${selectedShards.length > 0 ? `${selectedShards[0]!.index + 1}-${selectedShards[selectedShards.length - 1]!.index + 1}` : "none"}`,
      `Selected shard ids: ${selectedShards.map(formatShardSummary).join(", ") || "none"}`,
    ].join("\n") + "\n",
  );

  if (dryRun || selectedShards.length === 0) {
    return;
  }

  if (!process.env.FLY_API_TOKEN || !process.env.FLY_RUNTIME_APP_NAME || !process.env.FLY_RUNTIME_IMAGE || !process.env.FLY_RUNTIME_SHARED_TOKEN) {
    throw new Error("Fly runtime env is incomplete. Expected FLY_API_TOKEN, FLY_RUNTIME_APP_NAME, FLY_RUNTIME_IMAGE, and FLY_RUNTIME_SHARED_TOKEN.");
  }

  const gateway = new FlyMachinesRuntimeGateway(store, blobStore, {
    apiToken: process.env.FLY_API_TOKEN,
    appName: process.env.FLY_RUNTIME_APP_NAME,
    runtimeAppUrl: process.env.FLY_RUNTIME_APP_URL,
    openAIApiKey: process.env.OPENAI_API_KEY,
    runtimeAgentModel: process.env.RUNTIME_AGENT_MODEL,
    image: process.env.FLY_RUNTIME_IMAGE,
    region: process.env.FLY_RUNTIME_REGION ?? "iad",
    runtimeSharedToken: process.env.FLY_RUNTIME_SHARED_TOKEN,
    machineCpuKind: process.env.FLY_RUNTIME_MACHINE_CPU_KIND === "performance" ? "performance" : "shared",
    machineCpus: process.env.FLY_RUNTIME_MACHINE_CPUS ? Number(process.env.FLY_RUNTIME_MACHINE_CPUS) : undefined,
    machineMemoryMb: process.env.FLY_RUNTIME_MACHINE_MEMORY_MB ? Number(process.env.FLY_RUNTIME_MACHINE_MEMORY_MB) : undefined,
    codexOpenAIBaseUrl: process.env.RUNTIME_CODEX_OPENAI_BASE_URL,
    codexProxyUpstreamBaseUrl: process.env.RUNTIME_OPENAI_PROXY_UPSTREAM_BASE_URL,
    workspaceDownloadBaseUrl: process.env.API_ORIGIN ?? implementation.apiOrigin,
    r2BucketName: process.env.RUNTIME_R2_BUCKET_NAME ?? bucketName,
    r2Endpoint: endpoint,
    r2AccessKeyId: accessKeyId,
    r2SecretAccessKey: secretAccessKey,
  });

  if (cleanupStale) {
    const cleaned = await gateway.cleanupStaleSpriteMachines(sessionId);
    process.stdout.write(`Cleaned ${cleaned} stale sprite machines before provisioning.\n`);
  }

  const startedAt = Date.now();
  const results = await mapWithConcurrency(selectedShards, concurrency, async (shard, index) => {
    process.stdout.write(`Provisioning ${formatShardSummary(shard)} [${index + 1}/${selectedShards.length}]...\n`);
    const result = await gateway.provisionSpriteShard({
      sessionId,
      implementationId,
      shard,
      expiresMinutes,
    });
    process.stdout.write(`Ready ${formatShardSummary(shard)} on machine ${result.machineId}.\n`);
    return result;
  });

  const liveMachines = await gateway.listSpriteSessionMachines(sessionId);
  process.stdout.write(`${JSON.stringify({
    ok: true,
    sessionId,
    elapsedMs: Date.now() - startedAt,
    requestedShardCount: selectedShards.length,
    provisionedShardCount: results.length,
    machines: liveMachines,
  }, null, 2)}\n`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack || error.message : String(error));
  process.exit(1);
});
