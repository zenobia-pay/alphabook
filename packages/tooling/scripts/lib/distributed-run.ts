import { access, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { spawn } from "node:child_process";

import { createWranglerD1Db } from "@alphabook/db";
import { listMirrorIds } from "@alphabook/source-gutenberg/mirror";

export interface DistributedShardBookRecord {
  ordinal: number;
  gutenbergId: string;
  workId: string;
  title: string;
  bookDir: string;
  cleanR2Key: string | null;
  chunksR2Key: string | null;
  bookHtmlR2Key: string | null;
}

export interface DistributedShardManifest {
  version: 1;
  generatedAt: string;
  shardId: string;
  shardNumber: number;
  shardSize: number;
  sourceType: "mirror";
  sourceRoot: string;
  sourceHost: string | null;
  ordinalStart: number;
  ordinalEndExclusive: number;
  totalMirrorBooks: number;
  selectedGutenbergIds: string[];
  books: DistributedShardBookRecord[];
  missingInD1: string[];
}

type D1WorkRow = {
  work_id: string;
  gutenberg_id: string | number | null;
  title: string;
  kind: "clean" | "chunks" | "book_html" | null;
  r2_key: string | null;
};

export function readArg(name: string): string | null {
  const index = process.argv.indexOf(name);
  if (index === -1) {
    return null;
  }
  return process.argv[index + 1] ?? null;
}

export function hasFlag(name: string): boolean {
  return process.argv.includes(name);
}

export function parsePositiveInt(rawValue: string | null, flagName: string, fallback: number): number {
  if (!rawValue) {
    return fallback;
  }
  const parsed = Number(rawValue);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`${flagName} must be a positive integer.`);
  }
  return parsed;
}

export function normalizeGutenbergId(value: string | number | null | undefined): string | null {
  if (value === null || value === undefined) {
    return null;
  }
  const raw = String(value).trim();
  if (!/^\d+$/u.test(raw)) {
    return null;
  }
  return String(Number(raw));
}

export function shardIdFromNumber(shardNumber: number): string {
  return `shard-${String(shardNumber).padStart(4, "0")}`;
}

export function shardNumberFromId(shardId: string): number {
  const match = shardId.match(/^shard-(\d{4,})$/u);
  if (!match) {
    throw new Error(`Invalid shard id: ${shardId}. Expected format shard-0001.`);
  }
  return Number(match[1]);
}

export function resolveShardSelection(options: {
  shardId: string | null;
  shardNumber: string | null;
}) {
  if (options.shardId) {
    return {
      shardId: options.shardId,
      shardNumber: shardNumberFromId(options.shardId),
    };
  }
  const shardNumber = parsePositiveInt(options.shardNumber, "--shard-number", 1);
  return {
    shardId: shardIdFromNumber(shardNumber),
    shardNumber,
  };
}

export async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

export async function ensureDirectory(path: string): Promise<void> {
  await mkdir(path, { recursive: true });
}

export async function writeJson(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

export async function readJsonFile<T>(path: string): Promise<T> {
  return JSON.parse(await readFile(path, "utf8")) as T;
}

export async function withTempDir<T>(prefix: string, fn: (path: string) => Promise<T>): Promise<T> {
  const directory = await mkdtemp(join(tmpdir(), prefix));
  try {
    return await fn(directory);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

export async function runCommand(
  command: string,
  args: string[],
  options: {
    cwd?: string;
    stdin?: string;
    env?: NodeJS.ProcessEnv;
    allowNonZero?: boolean;
  } = {},
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  return await new Promise((resolvePromise, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: {
        ...process.env,
        ...options.env,
      },
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
      const exitCode = code ?? -1;
      if (exitCode !== 0 && !options.allowNonZero) {
        reject(new Error([stderr.trim(), stdout.trim()].filter(Boolean).join("\n") || `${command} exited with code ${exitCode}`));
        return;
      }
      resolvePromise({ stdout, stderr, exitCode });
    });
    child.stdin.end(options.stdin ?? "");
  });
}

export async function runStreamingCommand(
  command: string,
  args: string[],
  options: {
    cwd?: string;
    env?: NodeJS.ProcessEnv;
  } = {},
): Promise<void> {
  await new Promise<void>((resolvePromise, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: {
        ...process.env,
        ...options.env,
      },
      stdio: "inherit",
    });
    child.on("error", reject);
    child.on("exit", (code) => {
      if ((code ?? -1) !== 0) {
        reject(new Error(`${command} exited with code ${code ?? -1}`));
        return;
      }
      resolvePromise();
    });
  });
}

export async function loadMirrorIdsFromSource(options: {
  sourceRoot: string;
  sourceHost: string | null;
}): Promise<string[]> {
  if (!options.sourceHost && await pathExists(options.sourceRoot)) {
    return listMirrorIds(options.sourceRoot);
  }
  if (!options.sourceHost) {
    throw new Error(`Mirror root does not exist locally: ${options.sourceRoot}`);
  }
  const python = `
import json, os, re
root = ${JSON.stringify(options.sourceRoot)}
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
  const { stdout } = await runCommand("ssh", [options.sourceHost, "python3", "-"], { stdin: python });
  return JSON.parse(stdout) as string[];
}

export async function fetchShardBooksFromD1(gutenbergIds: string[]): Promise<Map<string, DistributedShardBookRecord>> {
  const db = createWranglerD1Db({
    cwd: process.cwd(),
    databaseName: process.env.D1_DATABASE_NAME ?? "alphabook-app",
    wranglerConfig: process.env.D1_WRANGLER_CONFIG ?? "apps/orchestrator-worker/wrangler.toml",
  });
  try {
    const rows = await db.query<D1WorkRow>(
      `
        SELECT
          w.id AS work_id,
          CAST(w.gutenberg_id AS TEXT) AS gutenberg_id,
          w.title AS title,
          wf.kind AS kind,
          wf.r2_key AS r2_key
        FROM works w
        LEFT JOIN work_files wf
          ON wf.work_id = w.id
         AND wf.kind IN ('clean', 'chunks', 'book_html')
        WHERE w.gutenberg_id IN $1
        ORDER BY CAST(w.gutenberg_id AS INTEGER) ASC, wf.kind ASC
      `,
      [gutenbergIds.map((id) => Number(id))],
    );
    const byId = new Map<string, DistributedShardBookRecord>();
    for (const row of rows.rows) {
      const gutenbergId = normalizeGutenbergId(row.gutenberg_id);
      if (!gutenbergId) {
        continue;
      }
      const existing = byId.get(gutenbergId) ?? {
        ordinal: 0,
        gutenbergId,
        workId: row.work_id,
        title: row.title,
        bookDir: join("books", gutenbergId),
        cleanR2Key: null,
        chunksR2Key: null,
        bookHtmlR2Key: null,
      };
      if (row.kind === "clean") {
        existing.cleanR2Key = row.r2_key;
      } else if (row.kind === "chunks") {
        existing.chunksR2Key = row.r2_key;
      } else if (row.kind === "book_html") {
        existing.bookHtmlR2Key = row.r2_key;
      }
      byId.set(gutenbergId, existing);
    }
    return byId;
  } finally {
    await db.end();
  }
}

export async function buildDistributedShardManifest(options: {
  shardId: string;
  shardNumber: number;
  shardSize: number;
  sourceRoot: string;
  sourceHost: string | null;
  allowMissingD1?: boolean;
}): Promise<DistributedShardManifest> {
  const mirrorIds = await loadMirrorIdsFromSource({
    sourceRoot: options.sourceRoot,
    sourceHost: options.sourceHost,
  });
  const ordinalStart = (options.shardNumber - 1) * options.shardSize;
  const ordinalEndExclusive = ordinalStart + options.shardSize;
  const selectedGutenbergIds = mirrorIds.slice(ordinalStart, ordinalEndExclusive);
  if (selectedGutenbergIds.length === 0) {
    throw new Error(`No mirror ids resolved for ${options.shardId}.`);
  }
  const d1Books = await fetchShardBooksFromD1(selectedGutenbergIds);
  const missingInD1 = selectedGutenbergIds.filter((gutenbergId) => !d1Books.has(gutenbergId));
  if (missingInD1.length > 0 && !options.allowMissingD1) {
    throw new Error(
      `Shard ${options.shardId} is missing ${missingInD1.length} Gutenberg ids in D1. `
      + `First missing ids: ${missingInD1.slice(0, 20).join(", ")}`,
    );
  }
  const books = selectedGutenbergIds.flatMap((gutenbergId, index) => {
    const book = d1Books.get(gutenbergId);
    if (!book) {
      return [];
    }
    return [{
      ...book,
      ordinal: ordinalStart + index + 1,
    }];
  });
  return {
    version: 1,
    generatedAt: new Date().toISOString(),
    shardId: options.shardId,
    shardNumber: options.shardNumber,
    shardSize: options.shardSize,
    sourceType: "mirror",
    sourceRoot: options.sourceRoot,
    sourceHost: options.sourceHost,
    ordinalStart,
    ordinalEndExclusive,
    totalMirrorBooks: mirrorIds.length,
    selectedGutenbergIds,
    books,
    missingInD1,
  };
}

export async function requireFile(path: string): Promise<void> {
  try {
    const value = await stat(path);
    if (!value.isFile()) {
      throw new Error(`${path} is not a file.`);
    }
  } catch (error) {
    throw new Error(`Expected file to exist: ${path}. ${error instanceof Error ? error.message : String(error)}`);
  }
}

export function printJson(value: unknown) {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

export function resolveOutputPath(path: string | null, fallback: string): string {
  return resolve(path ?? fallback);
}
