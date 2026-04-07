import { spawn } from "node:child_process";
import { mkdir, stat, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

import { GetObjectCommand, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { createWranglerD1Db, loadLocalDevVars } from "@alphabook/db";
import { getImplementationConfig } from "@alphabook/implementations";
import { listMirrorIds } from "@alphabook/source-gutenberg/mirror";

import { D1AppStore } from "../../../apps/orchestrator-worker/src/d1-store";
import { MAX_SPRITE_SHARD_SIZE, type SpriteShardCatalog, type SpriteShardManifest } from "../../../apps/orchestrator-worker/src/sprite-fanout";
import { FlyMachinesRuntimeGateway } from "../../../apps/orchestrator-worker/src/runtime";
import type { BlobObject, BlobStore } from "../../../apps/orchestrator-worker/src/r2";

const DEFAULT_CONCURRENCY = 1;
const DEFAULT_EXPIRES_MINUTES = 15;
const DEFAULT_PROVISION_USER_ID = "sprite-provisioner";
const DEFAULT_MIRROR_HOST = "root@134.209.116.167";
const DEFAULT_MIRROR_ROOT = "/srv/alphabook/gutenberg";
const D1_LOOKUP_BATCH_SIZE = 1000;

type CorpusSource = "d1" | "mirror";

type MirrorResolution = {
  mirrorIds: string[];
  catalog: SpriteShardCatalog;
  missingWorkIds: string[];
  missingCleanIds: string[];
};

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

function normalizeGutenbergId(id: string | number | null | undefined): string | null {
  if (id === null || id === undefined) {
    return null;
  }
  const raw = String(id).trim();
  if (!/^\d+$/u.test(raw)) {
    return null;
  }
  return String(Number(raw));
}

function formatShardSummary(shard: SpriteShardManifest): string {
  return `${shard.shardId} (${shard.bookCount} books)`;
}

function sliceIntoBatches<T>(items: T[], size: number): T[][] {
  const batches: T[][] = [];
  for (let index = 0; index < items.length; index += size) {
    batches.push(items.slice(index, index + size));
  }
  return batches;
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

async function pathExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

async function runCommand(
  command: string,
  args: string[],
  options: {
    cwd?: string;
    stdin?: string;
  } = {},
): Promise<string> {
  return await new Promise<string>((resolvePromise, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: process.env,
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += String(chunk);
    });
    child.stderr.on("data", (chunk) => {
      stderr += String(chunk);
    });
    child.on("error", reject);
    child.on("exit", (code) => {
      if (code !== 0) {
        reject(new Error([stderr.trim(), stdout.trim()].filter(Boolean).join("\n") || `${command} exited with code ${code ?? -1}`));
        return;
      }
      resolvePromise(stdout);
    });
    child.stdin.end(options.stdin ?? "");
  });
}

async function loadMirrorIdsFromRemote(host: string, root: string): Promise<string[]> {
  const python = `
import json, os, re
root = ${JSON.stringify(root)}
ids = set()
for dirpath, dirnames, filenames in os.walk(root):
    for name in filenames:
        lower = name.lower()
        match = re.match(r'^(?:pg)?(\\d+)(?:-[a-z0-9]+)?\\.(?:txt|htm|html)(?:\\.utf-8)?$', lower)
        if match:
            ids.add(str(int(match.group(1))))
    if dirpath.endswith('/cache/epub'):
        ids.update(str(int(name)) for name in dirnames if name.isdigit())
print(json.dumps(sorted(ids, key=lambda value: int(value))))
`;
  const stdout = await runCommand("ssh", [host, "python3", "-"], { stdin: python });
  return JSON.parse(stdout) as string[];
}

async function loadMirrorIds(
  source: CorpusSource,
  mirrorRoot: string | null,
  mirrorHost: string | null,
): Promise<string[] | null> {
  if (source !== "mirror") {
    return null;
  }
  const resolvedRoot = mirrorRoot ?? DEFAULT_MIRROR_ROOT;
  if (await pathExists(resolvedRoot)) {
    return listMirrorIds(resolvedRoot);
  }
  const host = mirrorHost ?? DEFAULT_MIRROR_HOST;
  return loadMirrorIdsFromRemote(host, resolvedRoot);
}

async function lookupWorksByGutenbergId(
  store: D1AppStore,
  gutenbergIds: string[],
): Promise<Map<string, { workId: string; byteSize: number }>> {
  const db = createWranglerD1Db({
    cwd: process.cwd(),
    databaseName: process.env.D1_DATABASE_NAME ?? "alphabook-app",
    wranglerConfig: process.env.D1_WRANGLER_CONFIG ?? "ops/cloudflare/resources.toml",
  });
  const mapping = new Map<string, { workId: string; byteSize: number }>();
  const normalizedIds = gutenbergIds
    .map((id) => normalizeGutenbergId(id))
    .filter((id): id is string => Boolean(id));

  for (const batch of sliceIntoBatches(normalizedIds, D1_LOOKUP_BATCH_SIZE)) {
    const rows = await db.query<{
      work_id: string;
      gutenberg_id: string | number | null;
    }>(
      `
        SELECT id AS work_id, CAST(gutenberg_id AS TEXT) AS gutenberg_id
        FROM works
        WHERE gutenberg_id IN $1
      `,
      [batch.map((id) => Number(id))],
    );
    const workIds = rows.rows.map((row) => row.work_id);
    const files = await store.getDocumentFiles(workIds, ["clean"]);
    const cleanByWorkId = new Map(files.map((file) => [file.documentId, file.byteSize ?? 0]));
    for (const row of rows.rows) {
      const normalized = normalizeGutenbergId(row.gutenberg_id);
      if (!normalized) {
        continue;
      }
      mapping.set(normalized, {
        workId: row.work_id,
        byteSize: cleanByWorkId.get(row.work_id) ?? 0,
      });
    }
  }

  await db.end();
  return mapping;
}

async function buildMirrorBackedCatalog(
  store: D1AppStore,
  blobStore: BlobStore,
  implementationId: string,
  shardSize: number,
  mirrorIds: string[],
): Promise<MirrorResolution> {
  const workLookup = await lookupWorksByGutenbergId(store, mirrorIds);
  const missingWorkIds: string[] = [];
  const missingCleanIds: string[] = [];
  const shards: SpriteShardManifest[] = [];

  for (let index = 0; index < mirrorIds.length; index += shardSize) {
    const slice = mirrorIds.slice(index, index + shardSize);
    const workIds: string[] = [];
    let totalTextBytes = 0;
    for (const mirrorId of slice) {
      const match = workLookup.get(mirrorId);
      if (!match) {
        missingWorkIds.push(mirrorId);
        continue;
      }
      workIds.push(match.workId);
      totalTextBytes += match.byteSize;
      if (!match.byteSize || match.byteSize <= 0) {
        missingCleanIds.push(mirrorId);
      }
    }
    shards.push({
      implementationId,
      shardId: `books-${Math.floor(index / shardSize) + 1}`,
      index: Math.floor(index / shardSize),
      totalShards: Math.max(1, Math.ceil(mirrorIds.length / shardSize)),
      bookCount: slice.length,
      workIds,
      totalTextBytes,
    });
  }

  const catalog: SpriteShardCatalog = {
    implementationId,
    generatedAt: new Date().toISOString(),
    shardSize,
    shardCount: shards.length,
    shards,
  };
  await blobStore.putJson(`sprite-shards/${implementationId}/catalog.json`, catalog);
  return {
    mirrorIds,
    catalog,
    missingWorkIds: Array.from(new Set(missingWorkIds)),
    missingCleanIds: Array.from(new Set(missingCleanIds)),
  };
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
  const source = (readArg("--source") ?? ((readArg("--mirror-root") || readArg("--mirror-host")) ? "mirror" : "d1")) as CorpusSource;
  const mirrorRoot = readArg("--mirror-root") ?? (source === "mirror" ? DEFAULT_MIRROR_ROOT : null);
  const mirrorHost = readArg("--mirror-host") ?? (source === "mirror" ? DEFAULT_MIRROR_HOST : null);

  if (source !== "d1" && source !== "mirror") {
    throw new Error("--source must be either d1 or mirror.");
  }

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
    wranglerConfig: process.env.D1_WRANGLER_CONFIG ?? "ops/cloudflare/resources.toml",
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

  const mirrorIds = await loadMirrorIds(source, mirrorRoot, mirrorHost);
  const mirrorResolution = mirrorIds
    ? await buildMirrorBackedCatalog(store, blobStore, implementationId, shardSize, mirrorIds)
    : null;
  const catalog = mirrorResolution?.catalog
    ?? {
      implementationId,
      generatedAt: new Date().toISOString(),
      shardSize,
      shardCount: 0,
      shards: [],
    };

  if (!mirrorResolution) {
    const totalDocuments = await store.countDocuments();
    const shards: SpriteShardManifest[] = [];
    for (let offset = 0; offset < totalDocuments; offset += shardSize) {
      const batch = await store.listDocuments(offset, shardSize);
      const workIds = batch.map((document) => document.id);
      const files = await store.getDocumentFiles(workIds, ["clean"]);
      shards.push({
        implementationId,
        shardId: `books-${Math.floor(offset / shardSize) + 1}`,
        index: Math.floor(offset / shardSize),
        totalShards: Math.max(1, Math.ceil(totalDocuments / shardSize)),
        bookCount: workIds.length,
        workIds,
        totalTextBytes: files.reduce((sum, file) => sum + (file.byteSize ?? 0), 0),
      });
    }
    catalog.shardCount = shards.length;
    catalog.shards = shards;
    await blobStore.putJson(`sprite-shards/${implementationId}/catalog.json`, catalog);
  }

  const selectedShards = catalog.shards.slice(startShard, maxShards == null ? undefined : startShard + maxShards);

  if (catalogFile) {
    const absolute = resolve(catalogFile);
    await mkdir(dirname(absolute), { recursive: true });
    await writeFile(absolute, `${JSON.stringify({
      source,
      mirrorHost,
      mirrorRoot,
      mirrorBookCount: mirrorResolution?.mirrorIds.length ?? null,
      missingWorkIds: mirrorResolution?.missingWorkIds ?? [],
      missingCleanIds: mirrorResolution?.missingCleanIds ?? [],
      catalog,
    }, null, 2)}\n`, "utf8");
  }

  process.stdout.write(
    [
      `Implementation: ${implementationId}`,
      `Session: ${sessionId}`,
      `Source: ${source}`,
      `Mirror root: ${mirrorRoot ?? "n/a"}`,
      `Mirror host: ${mirrorHost ?? "n/a"}`,
      `Total books: ${mirrorResolution?.mirrorIds.length ?? catalog.shards.reduce((sum, shard) => sum + shard.bookCount, 0)}`,
      `Resolved books in D1: ${catalog.shards.reduce((sum, shard) => sum + shard.workIds.length, 0)}`,
      `Missing works in D1: ${mirrorResolution?.missingWorkIds.length ?? 0}`,
      `Missing clean artifacts: ${mirrorResolution?.missingCleanIds.length ?? 0}`,
      `Shard size: ${catalog.shardSize}`,
      `Shard count: ${catalog.shardCount}`,
      `Selected shards: ${selectedShards.length}`,
      `Selected range: ${selectedShards.length > 0 ? `${selectedShards[0]!.index + 1}-${selectedShards[selectedShards.length - 1]!.index + 1}` : "none"}`,
      `Selected shard ids: ${selectedShards.map(formatShardSummary).join(", ") || "none"}`,
    ].join("\n") + "\n",
  );

  if (mirrorResolution && (mirrorResolution.missingWorkIds.length > 0 || mirrorResolution.missingCleanIds.length > 0)) {
    const missingWorkPreview = mirrorResolution.missingWorkIds.slice(0, 20).join(", ");
    const missingCleanPreview = mirrorResolution.missingCleanIds.slice(0, 20).join(", ");
    throw new Error(
      [
        `Mirror-backed sprite provisioning is incomplete.`,
        mirrorResolution.missingWorkIds.length > 0
          ? `Missing D1 works for ${mirrorResolution.missingWorkIds.length} Gutenberg ids. First ids: ${missingWorkPreview}`
          : null,
        mirrorResolution.missingCleanIds.length > 0
          ? `Missing clean artifacts for ${mirrorResolution.missingCleanIds.length} Gutenberg ids. First ids: ${missingCleanPreview}`
          : null,
      ].filter(Boolean).join("\n"),
    );
  }

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
