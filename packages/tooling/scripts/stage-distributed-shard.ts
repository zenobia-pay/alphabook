import { appendFile, mkdir, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";

import { loadLocalDevVars } from "@alphabook/db";

import type { DistributedShardManifest } from "./lib/distributed-run";
import {
  ensureDirectory,
  hasFlag,
  pathExists,
  printJson,
  readArg,
  readJsonFile,
  requireFile,
  runStreamingCommand,
  withTempDir,
  writeJson,
} from "./lib/distributed-run";

type QdrantScrollResponse = {
  result?: {
    points?: Array<{
      id: string | number;
      payload?: Record<string, unknown>;
      vector?: unknown;
    }>;
    next_page_offset?: string | number | null;
  };
};

const DEFAULT_QDRANT_BATCH_IDS = 100;
const DEFAULT_QDRANT_SCROLL_LIMIT = 256;
const DEFAULT_QDRANT_TIMEOUT_SECONDS = 120;

function usage() {
  process.stdout.write(
    [
      "Usage: node --import tsx packages/tooling/scripts/stage-distributed-shard.ts --manifest <path> [options]",
      "",
      "Options:",
      "  --output-dir <path>",
      "  --books-root </mnt/alphabook_consolidation/final/latest>",
      "  --books-host <root@host>",
      "  --qdrant-url <https://...>",
      "  --qdrant-api-key <token>",
      "  --qdrant-collection <alphabook-semantic>",
      "  --qdrant-id-batch-size <100>",
      "  --qdrant-scroll-limit <256>",
      "  --qdrant-timeout-seconds <120>",
      "  --skip-books",
      "  --skip-vectors",
    ].join("\n") + "\n",
  );
}

function chunk<T>(items: T[], size: number): T[][] {
  const batches: T[][] = [];
  for (let index = 0; index < items.length; index += size) {
    batches.push(items.slice(index, index + size));
  }
  return batches;
}

async function exportQdrantPoints(options: {
  manifest: DistributedShardManifest;
  outputDir: string;
  qdrantUrl: string;
  qdrantApiKey: string | null;
  qdrantCollection: string;
  idBatchSize: number;
  scrollLimit: number;
  timeoutSeconds: number;
}) {
  const outputPath = join(options.outputDir, "vectors", "qdrant-points.ndjson");
  await mkdir(join(options.outputDir, "vectors"), { recursive: true });
  await writeFile(outputPath, "", "utf8");

  let totalPoints = 0;
  const countsByBook = new Map<string, number>();
  for (const idBatch of chunk(options.manifest.selectedGutenbergIds, options.idBatchSize)) {
    let offset: string | number | null = null;
    while (true) {
      const body: Record<string, unknown> = {
        limit: options.scrollLimit,
        with_payload: true,
        with_vector: true,
        timeout: options.timeoutSeconds,
        filter: {
          must: [
            {
              key: "gutenberg_id",
              match: {
                any: idBatch,
              },
            },
          ],
        },
      };
      if (offset !== null) {
        body.offset = offset;
      }
      const response = await fetch(
        `${options.qdrantUrl.replace(/\/+$/u, "")}/collections/${options.qdrantCollection}/points/scroll`,
        {
          method: "POST",
          headers: {
            "content-type": "application/json",
            ...(options.qdrantApiKey ? { "api-key": options.qdrantApiKey } : {}),
          },
          body: JSON.stringify(body),
        },
      );
      if (!response.ok) {
        throw new Error(`Qdrant scroll failed: ${response.status} ${await response.text()}`);
      }
      const payload = await response.json() as QdrantScrollResponse;
      const points = payload.result?.points ?? [];
      if (points.length === 0) {
        break;
      }
      await appendFile(
        outputPath,
        `${points.map((point) => JSON.stringify(point)).join("\n")}\n`,
        "utf8",
      );
      totalPoints += points.length;
      for (const point of points) {
        const gutenbergId = typeof point.payload?.gutenberg_id === "string"
          ? point.payload.gutenberg_id
          : typeof point.payload?.gutenberg_id === "number"
            ? String(point.payload.gutenberg_id)
            : null;
        if (!gutenbergId) {
          continue;
        }
        countsByBook.set(gutenbergId, (countsByBook.get(gutenbergId) ?? 0) + 1);
      }
      offset = payload.result?.next_page_offset ?? null;
      if (offset === null) {
        break;
      }
    }
  }

  const summary = {
    generatedAt: new Date().toISOString(),
    shardId: options.manifest.shardId,
    qdrantUrl: options.qdrantUrl,
    qdrantCollection: options.qdrantCollection,
    totalPoints,
    countsByBook: Object.fromEntries(
      options.manifest.selectedGutenbergIds.map((gutenbergId) => [gutenbergId, countsByBook.get(gutenbergId) ?? 0]),
    ),
    outputPath,
  };
  await writeJson(join(options.outputDir, "vectors", "summary.json"), summary);
  return summary;
}

async function syncBooks(options: {
  manifest: DistributedShardManifest;
  outputDir: string;
  booksRoot: string;
  booksHost: string | null;
}) {
  const stageBooksRoot = join(options.outputDir, "books");
  await rm(stageBooksRoot, { recursive: true, force: true });
  await ensureDirectory(stageBooksRoot);
  await withTempDir("alphabook-distributed-books-", async (tempDir) => {
    const filesFromPath = join(tempDir, "files-from.txt");
    await writeFile(
      filesFromPath,
      `${options.manifest.selectedGutenbergIds.map((gutenbergId) => `books/${gutenbergId}/`).join("\n")}\n`,
      "utf8",
    );
    const source = options.booksHost
      ? `${options.booksHost}:${options.booksRoot.replace(/\/+$/u, "")}/`
      : `${options.booksRoot.replace(/\/+$/u, "")}/`;
    await runStreamingCommand("rsync", [
      "-az",
      "--prune-empty-dirs",
      "--files-from",
      filesFromPath,
      source,
      `${options.outputDir}/`,
    ]);
  });
}

async function main() {
  if (hasFlag("--help")) {
    usage();
    return;
  }

  await loadLocalDevVars(process.cwd());
  const manifestPath = readArg("--manifest");
  if (!manifestPath) {
    throw new Error("--manifest is required.");
  }
  await requireFile(manifestPath);
  const manifest = await readJsonFile<DistributedShardManifest>(manifestPath);
  const outputDir = resolve(readArg("--output-dir") ?? `output/distributed-run/${manifest.shardId}/stage`);
  const booksRoot = readArg("--books-root") ?? manifest.sourceRoot;
  const booksHost = readArg("--books-host") ?? manifest.sourceHost;
  const skipBooks = hasFlag("--skip-books");
  const skipVectors = hasFlag("--skip-vectors");

  await rm(outputDir, { recursive: true, force: true });
  await ensureDirectory(outputDir);
  await writeJson(join(outputDir, "manifest.json"), manifest);
  await writeFile(
    join(outputDir, "gutenberg-ids.txt"),
    `${manifest.selectedGutenbergIds.join("\n")}\n`,
    "utf8",
  );

  if (!skipBooks) {
    await syncBooks({
      manifest,
      outputDir,
      booksRoot,
      booksHost,
    });
  }

  let vectorSummary: Record<string, unknown> | null = null;
  if (!skipVectors) {
    const qdrantUrl = readArg("--qdrant-url") ?? process.env.QDRANT_URL ?? null;
    const qdrantCollection = readArg("--qdrant-collection") ?? process.env.QDRANT_COLLECTION ?? null;
    const qdrantApiKey = readArg("--qdrant-api-key") ?? process.env.QDRANT_API_KEY ?? null;
    if (!qdrantUrl || !qdrantCollection) {
      throw new Error("Qdrant export requires --qdrant-url and --qdrant-collection (or env vars).");
    }
    vectorSummary = await exportQdrantPoints({
      manifest,
      outputDir,
      qdrantUrl,
      qdrantApiKey,
      qdrantCollection,
      idBatchSize: Number(readArg("--qdrant-id-batch-size") ?? DEFAULT_QDRANT_BATCH_IDS),
      scrollLimit: Number(readArg("--qdrant-scroll-limit") ?? DEFAULT_QDRANT_SCROLL_LIMIT),
      timeoutSeconds: Number(readArg("--qdrant-timeout-seconds") ?? DEFAULT_QDRANT_TIMEOUT_SECONDS),
    });
  }

  const booksPresent = await pathExists(join(outputDir, "books"));
  printJson({
    ok: true,
    shardId: manifest.shardId,
    outputDir,
    booksPresent,
    vectorsPresent: await pathExists(join(outputDir, "vectors", "qdrant-points.ndjson")),
    vectorSummary,
  });
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack || error.message : String(error));
  process.exit(1);
});
