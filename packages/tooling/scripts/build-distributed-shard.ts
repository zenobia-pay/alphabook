import { loadLocalDevVars } from "@alphabook/db";

import {
  buildDistributedShardManifest,
  hasFlag,
  parsePositiveInt,
  printJson,
  readArg,
  resolveOutputPath,
  resolveShardSelection,
  writeJson,
} from "./lib/distributed-run";

const DEFAULT_SHARD_SIZE = 1000;
const DEFAULT_SOURCE_ROOT = "/mnt/alphabook_consolidation/final/latest";

function usage() {
  process.stdout.write(
    [
      "Usage: node --import tsx packages/tooling/scripts/build-distributed-shard.ts [options]",
      "",
      "Options:",
      "  --shard-id <shard-0001>",
      "  --shard-number <1>",
      "  --shard-size <1000>",
      "  --source-root </mnt/alphabook_consolidation/final/latest>",
      "  --source-host <root@host>",
      "  --output <path>",
      "  --allow-missing-d1",
    ].join("\n") + "\n",
  );
}

async function main() {
  if (hasFlag("--help")) {
    usage();
    return;
  }

  await loadLocalDevVars(process.cwd());
  const { shardId, shardNumber } = resolveShardSelection({
    shardId: readArg("--shard-id"),
    shardNumber: readArg("--shard-number"),
  });
  const shardSize = parsePositiveInt(readArg("--shard-size"), "--shard-size", DEFAULT_SHARD_SIZE);
  const sourceRoot = readArg("--source-root") ?? DEFAULT_SOURCE_ROOT;
  const sourceHost = readArg("--source-host");
  const outputPath = resolveOutputPath(
    readArg("--output"),
    `output/distributed-run/${shardId}/manifest.json`,
  );

  const manifest = await buildDistributedShardManifest({
    shardId,
    shardNumber,
    shardSize,
    sourceRoot,
    sourceHost,
    allowMissingD1: hasFlag("--allow-missing-d1"),
  });

  await writeJson(outputPath, manifest);
  printJson({
    ok: true,
    shardId: manifest.shardId,
    shardNumber: manifest.shardNumber,
    shardSize: manifest.shardSize,
    outputPath,
    selectedBooks: manifest.selectedGutenbergIds.length,
    resolvedBooks: manifest.books.length,
    missingInD1: manifest.missingInD1.length,
    firstGutenbergId: manifest.selectedGutenbergIds[0] ?? null,
    lastGutenbergId: manifest.selectedGutenbergIds.at(-1) ?? null,
  });
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack || error.message : String(error));
  process.exit(1);
});
