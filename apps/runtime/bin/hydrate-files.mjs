#!/usr/bin/env node

import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import process from "node:process";

import { GetObjectCommand, S3Client } from "@aws-sdk/client-s3";

function parseArgs(argv) {
  const options = {
    all: false,
    force: false,
    works: [],
    kinds: [],
    r2Keys: [],
    paths: [],
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const next = argv[index + 1];
    switch (arg) {
      case "--all":
        options.all = true;
        break;
      case "--force":
        options.force = true;
        break;
      case "--work":
        if (next) {
          options.works.push(next);
          index += 1;
        }
        break;
      case "--kind":
        if (next) {
          options.kinds.push(next);
          index += 1;
        }
        break;
      case "--r2-key":
        if (next) {
          options.r2Keys.push(next);
          index += 1;
        }
        break;
      case "--path":
        if (next) {
          options.paths.push(next);
          index += 1;
        }
        break;
      default:
        break;
    }
  }

  return options;
}

async function fileExists(path) {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

function matchesKind(entry, kinds) {
  return kinds.length === 0 || kinds.includes(String(entry.kind || ""));
}

function selectEntries(manifest, options) {
  const catalog = Array.isArray(manifest.fileCatalog) ? manifest.fileCatalog : [];
  if (options.all) {
    return catalog.filter((entry) => matchesKind(entry, options.kinds));
  }

  const byWork = options.works.length > 0
    ? catalog.filter((entry) => options.works.includes(String(entry.workId || "")) && matchesKind(entry, options.kinds))
    : [];
  const byKey = options.r2Keys.length > 0
    ? catalog.filter((entry) => options.r2Keys.includes(String(entry.r2Key || "")))
    : [];
  const byPath = options.paths.length > 0
    ? catalog.filter((entry) => options.paths.includes(String(entry.destinationPath || "")))
    : [];

  const merged = [...byWork, ...byKey, ...byPath];
  const seen = new Set();
  return merged.filter((entry) => {
    const key = String(entry.r2Key || entry.destinationPath || "");
    if (!key || seen.has(key)) {
      return false;
    }
    seen.add(key);
    return true;
  });
}

async function downloadFromR2(client, bucket, r2Key) {
  const response = await client.send(new GetObjectCommand({
    Bucket: bucket,
    Key: r2Key,
  }));
  if (!response.Body) {
    throw new Error(`R2 object ${r2Key} had no body.`);
  }
  if (typeof response.Body.transformToString === "function") {
    return response.Body.transformToString();
  }

  const chunks = [];
  for await (const chunk of response.Body) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString("utf8");
}

async function main() {
  const scriptPath = process.argv[1];
  const contextDir = dirname(scriptPath);
  const workspaceRoot = dirname(contextDir);
  const manifestPath = join(contextDir, "manifest.json");
  const options = parseArgs(process.argv.slice(2));
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  const entries = selectEntries(manifest, options);

  if (entries.length === 0) {
    process.stdout.write(JSON.stringify({ downloaded: [], count: 0 }, null, 2));
    return;
  }

  const endpoint = process.env.R2_ENDPOINT;
  const accessKeyId = process.env.R2_ACCESS_KEY_ID;
  const secretAccessKey = process.env.R2_SECRET_ACCESS_KEY;
  const bucket = process.env.R2_BUCKET_NAME;
  if (!endpoint || !accessKeyId || !secretAccessKey || !bucket) {
    throw new Error("R2 runtime credentials are not configured.");
  }

  const client = new S3Client({
    region: "auto",
    endpoint,
    forcePathStyle: true,
    credentials: {
      accessKeyId,
      secretAccessKey,
    },
  });

  const downloaded = [];
  for (const entry of entries) {
    const destination = join(workspaceRoot, String(entry.destinationPath || ""));
    if (!options.force && await fileExists(destination)) {
      downloaded.push({
        ...entry,
        skipped: true,
      });
      continue;
    }

    await mkdir(dirname(destination), { recursive: true });
    const body = await downloadFromR2(client, bucket, String(entry.r2Key || ""));
    await writeFile(destination, body, "utf8");
    downloaded.push({
      ...entry,
      skipped: false,
    });
  }

  process.stdout.write(JSON.stringify({
    downloaded,
    count: downloaded.length,
  }, null, 2));
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack || error.message : String(error));
  process.exit(1);
});
