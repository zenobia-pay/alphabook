#!/usr/bin/env node

import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { S3Client, PutObjectCommand } from "@aws-sdk/client-s3";

function parseArgs(argv) {
  const args = {
    runDir: "",
    jobId: "",
    sessionId: "",
    runId: "",
    archivePrefix: "",
    callbackUrl: "",
    callbackToken: "",
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const next = argv[index + 1];
    if (arg === "--run-dir" && next) {
      args.runDir = next;
      index += 1;
      continue;
    }
    if (arg === "--job-id" && next) {
      args.jobId = next;
      index += 1;
      continue;
    }
    if (arg === "--session-id" && next) {
      args.sessionId = next;
      index += 1;
      continue;
    }
    if (arg === "--run-id" && next) {
      args.runId = next;
      index += 1;
      continue;
    }
    if (arg === "--archive-prefix" && next) {
      args.archivePrefix = next.replace(/\/+$/u, "");
      index += 1;
      continue;
    }
    if (arg === "--callback-url" && next) {
      args.callbackUrl = next;
      index += 1;
      continue;
    }
    if (arg === "--callback-token" && next) {
      args.callbackToken = next;
      index += 1;
      continue;
    }
  }
  if (!args.runDir || !args.jobId || !args.sessionId || !args.runId || !args.archivePrefix) {
    throw new Error("Missing required arguments for archive-hermes-run.mjs");
  }
  return args;
}

function nowIso() {
  return new Date().toISOString();
}

async function readJson(filePath) {
  try {
    return JSON.parse(await fs.readFile(filePath, "utf8"));
  } catch {
    return null;
  }
}

async function writeJson(filePath, value) {
  await fs.writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

async function inferInnerRunDir(runDir) {
  try {
    const explicit = (await fs.readFile(path.join(runDir, "inner-run-dir.txt"), "utf8")).trim();
    if (explicit) {
      return explicit;
    }
  } catch {}
  const index = await readJson(path.join(runDir, "index.json"));
  return typeof index?.inner_run_dir === "string" ? index.inner_run_dir : null;
}

function contentTypeFor(relativePath) {
  const normalized = relativePath.toLowerCase();
  if (normalized.endsWith(".md")) {
    return "text/markdown; charset=utf-8";
  }
  if (normalized.endsWith(".json")) {
    return "application/json; charset=utf-8";
  }
  if (normalized.endsWith(".jsonl")) {
    return "application/x-ndjson; charset=utf-8";
  }
  if (normalized.endsWith(".csv")) {
    return "text/csv; charset=utf-8";
  }
  if (normalized.endsWith(".tsv")) {
    return "text/tab-separated-values; charset=utf-8";
  }
  if (normalized.endsWith(".svg")) {
    return "image/svg+xml";
  }
  if (normalized.endsWith(".txt") || normalized.endsWith(".log") || normalized.endsWith(".py") || normalized.endsWith(".sh")) {
    return "text/plain; charset=utf-8";
  }
  return "application/octet-stream";
}

async function listRegularFiles(rootDir, prefix) {
  const files = [];
  async function walk(currentDir) {
    const entries = await fs.readdir(currentDir, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = path.join(currentDir, entry.name);
      if (entry.isSymbolicLink()) {
        continue;
      }
      if (entry.isDirectory()) {
        await walk(fullPath);
        continue;
      }
      if (!entry.isFile()) {
        continue;
      }
      const stat = await fs.stat(fullPath);
      const relativePath = path.posix.join(prefix, path.relative(rootDir, fullPath).split(path.sep).join("/"));
      files.push({
        relativePath,
        sourcePath: fullPath,
        byteSize: stat.size,
        mimeType: contentTypeFor(relativePath),
        uploadedAt: null,
      });
    }
  }
  await walk(rootDir);
  return files;
}

async function createClient() {
  const bucket = process.env.R2_BUCKET_NAME;
  const endpoint = process.env.R2_ENDPOINT;
  const accessKeyId = process.env.R2_ACCESS_KEY_ID;
  const secretAccessKey = process.env.R2_SECRET_ACCESS_KEY;
  if (!bucket || !endpoint || !accessKeyId || !secretAccessKey) {
    throw new Error("R2 archive configuration is missing.");
  }
  return {
    bucket,
    client: new S3Client({
      region: "auto",
      endpoint,
      forcePathStyle: true,
      credentials: {
        accessKeyId,
        secretAccessKey,
      },
    }),
  };
}

async function uploadFiles(client, bucket, archivePrefix, files) {
  const uploadedAt = nowIso();
  const uploaded = [];
  for (const file of files) {
    const body = await fs.readFile(file.sourcePath);
    const r2Key = `${archivePrefix}/${file.relativePath}`;
    await client.send(new PutObjectCommand({
      Bucket: bucket,
      Key: r2Key,
      Body: body,
      ContentType: file.mimeType,
    }));
    uploaded.push({
      ...file,
      r2Key,
      uploadedAt,
    });
  }
  return uploaded;
}

async function updateWrapperState(runDir, archive) {
  for (const filename of ["status.json", "summary.json", "index.json"]) {
    const target = path.join(runDir, filename);
    const payload = await readJson(target);
    if (!payload) {
      continue;
    }
    payload.archive = archive;
    await writeJson(target, payload);
  }
}

async function notifyCallback(args, status) {
  if (!args.callbackUrl) {
    return;
  }
  const headers = {
    "content-type": "application/json",
    ...(args.callbackToken ? { authorization: `Bearer ${args.callbackToken}` } : {}),
  };
  const body = JSON.stringify({
    sessionId: args.sessionId,
    runId: args.runId,
    jobId: args.jobId,
    status,
  });
  let lastError = null;
  for (let attempt = 0; attempt < 8; attempt += 1) {
    try {
      const response = await fetch(args.callbackUrl, {
        method: "POST",
        headers,
        body,
      });
      if (response.ok) {
        return;
      }
      lastError = new Error(`callback failed with status ${response.status}`);
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, Math.min(30_000, 1_000 * (2 ** attempt))));
  }
  if (lastError) {
    throw lastError;
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const runDir = path.resolve(args.runDir);
  const innerRunDir = await inferInnerRunDir(runDir);
  const wrapperFiles = await listRegularFiles(runDir, "wrapper");
  const innerFiles = innerRunDir ? await listRegularFiles(innerRunDir, "inner") : [];
  const { client, bucket } = await createClient();
  const uploadedFiles = await uploadFiles(client, bucket, args.archivePrefix, [...wrapperFiles, ...innerFiles]);
  const manifest = {
    version: 1,
    jobId: args.jobId,
    sessionId: args.sessionId,
    runId: args.runId,
    archivePrefix: args.archivePrefix,
    uploadedAt: nowIso(),
    files: uploadedFiles,
  };
  const manifestKey = `${args.archivePrefix}/archive-manifest.json`;
  await client.send(new PutObjectCommand({
    Bucket: bucket,
    Key: manifestKey,
    Body: JSON.stringify(manifest, null, 2),
    ContentType: "application/json; charset=utf-8",
  }));
  await fs.writeFile(path.join(runDir, "archive-manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`, "utf8");

  const archiveState = {
    status: "uploaded",
    prefix: args.archivePrefix,
    manifestKey,
    fileCount: uploadedFiles.length,
    updatedAt: nowIso(),
  };
  await updateWrapperState(runDir, archiveState);

  const statusPayload = await readJson(path.join(runDir, "status.json"));
  await notifyCallback(args, typeof statusPayload?.state === "string" ? statusPayload.state : "completed");
}

main().catch(async (error) => {
  const args = (() => {
    try {
      return parseArgs(process.argv.slice(2));
    } catch {
      return null;
    }
  })();
  if (args?.runDir) {
    try {
      await updateWrapperState(path.resolve(args.runDir), {
        status: "failed",
        prefix: args.archivePrefix,
        manifestKey: null,
        fileCount: null,
        updatedAt: nowIso(),
        error: error instanceof Error ? error.message : String(error),
      });
    } catch {}
  }
  console.error(error instanceof Error ? error.stack || error.message : String(error));
  process.exit(1);
});
