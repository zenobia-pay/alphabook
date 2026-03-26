import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

import { S3Client, PutObjectCommand } from "@aws-sdk/client-s3";
import { createWranglerD1Db, loadLocalDevVars } from "@alphabook/db";
import { getImplementationConfig } from "@alphabook/implementations";
import { D1AppStore } from "../../../apps/orchestrator-worker/src/d1-store";

const DEFAULT_SHARD_SIZE = 1000;

function readArg(name: string): string | null {
  const index = process.argv.indexOf(name);
  if (index === -1) {
    return null;
  }
  return process.argv[index + 1] ?? null;
}

async function main() {
  await loadLocalDevVars(process.cwd());
  const implementationId = readArg("--implementation") ?? "alphabook";
  const shardSize = Number(readArg("--shard-size") ?? DEFAULT_SHARD_SIZE);
  if (!Number.isInteger(shardSize) || shardSize <= 0) {
    throw new Error("--shard-size must be a positive integer.");
  }

  const implementation = getImplementationConfig(implementationId);
  const store = new D1AppStore(createWranglerD1Db({
    cwd: process.cwd(),
    databaseName: process.env.D1_DATABASE_NAME ?? "alphabook-app",
    wranglerConfig: process.env.D1_WRANGLER_CONFIG ?? "apps/orchestrator-worker/wrangler.toml",
  }), {
    adapterId: implementation.adapterId,
    feedLabels: implementation.feedLabels,
  });

  const totalDocuments = await store.countDocuments();
  const documents = [];
  for (let offset = 0; offset < totalDocuments; offset += shardSize) {
    const batch = await store.listDocuments(offset, shardSize);
    documents.push(...batch);
  }

  const shards = [];
  for (let offset = 0; offset < documents.length; offset += shardSize) {
    const batch = documents.slice(offset, offset + shardSize);
    const workIds = batch.map((document) => document.id);
    const files = await store.getDocumentFiles(workIds, ["clean"]);
    shards.push({
      implementationId,
      shardId: `books-${Math.floor(offset / shardSize) + 1}`,
      index: Math.floor(offset / shardSize),
      totalShards: Math.max(1, Math.ceil(documents.length / shardSize)),
      bookCount: workIds.length,
      workIds,
      totalTextBytes: files.reduce((sum, file) => sum + (file.byteSize ?? 0), 0),
    });
  }

  const catalog = {
    implementationId,
    generatedAt: new Date().toISOString(),
    shardSize,
    shardCount: shards.length,
    shards,
  };
  const json = JSON.stringify(catalog, null, 2);

  const filePath = readArg("--file");
  if (filePath) {
    const absolute = resolve(filePath);
    await mkdir(dirname(absolute), { recursive: true });
    await writeFile(absolute, json, "utf8");
  }

  const bucketName = process.env.R2_BUCKET_NAME;
  const endpoint = process.env.R2_ENDPOINT;
  const accessKeyId = process.env.R2_ACCESS_KEY_ID;
  const secretAccessKey = process.env.R2_SECRET_ACCESS_KEY;
  const r2Key = readArg("--r2-key") ?? `sprite-shards/${implementationId}/catalog.json`;
  if (bucketName && endpoint && accessKeyId && secretAccessKey) {
    const client = new S3Client({
      region: "auto",
      endpoint,
      credentials: {
        accessKeyId,
        secretAccessKey,
      },
    });
    await client.send(new PutObjectCommand({
      Bucket: bucketName,
      Key: r2Key,
      Body: json,
      ContentType: "application/json; charset=utf-8",
    }));
  }

  process.stdout.write(`${json}\n`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack || error.message : String(error));
  process.exit(1);
});
