import { loadLocalDevVars } from "@alphabook/db";

import {
  buildDistributedShardManifest,
  hasFlag,
  printJson,
  readArg,
  resolveShardSelection,
  runStreamingCommand,
  writeJson,
} from "./lib/distributed-run";

const DEFAULT_SOURCE_ROOT = "/mnt/alphabook_consolidation/final/latest";
const DEFAULT_SHARD_SIZE = 1000;

function usage() {
  process.stdout.write(
    [
      "Usage: node --import tsx packages/tooling/scripts/setup-distributed-run.ts [options]",
      "",
      "This is the one-shot manual provisioning flow for a persistent shard machine.",
      "",
      "Options:",
      "  --shard-id <shard-0001>",
      "  --shard-number <1>",
      "  --shard-size <1000>",
      "  --source-root </mnt/alphabook_consolidation/final/latest>",
      "  --source-host <root@host>",
      "  --books-root <same as source-root by default>",
      "  --books-host <same as source-host by default>",
      "  --output-root <output/distributed-run>",
      "  --fly-app <alphabook-distributed-run>",
      "  --fly-org <org>",
      "  --fly-region <iad>",
      "  --fly-image <registry.fly.io/...>",
      "  --runtime-shared-token <token>",
      "  --skip-books",
      "  --skip-vectors",
      "  --skip-service",
      "  --dry-run",
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
  const shardSize = Number(readArg("--shard-size") ?? DEFAULT_SHARD_SIZE);
  const outputRoot = readArg("--output-root") ?? "output/distributed-run";
  const shardRoot = `${outputRoot}/${shardId}`;
  const manifestPath = `${shardRoot}/manifest.json`;
  const stageDir = `${shardRoot}/stage`;
  const sourceRoot = readArg("--source-root") ?? DEFAULT_SOURCE_ROOT;
  const sourceHost = readArg("--source-host");
  const manifest = await buildDistributedShardManifest({
    shardId,
    shardNumber,
    shardSize,
    sourceRoot,
    sourceHost,
  });
  await writeJson(manifestPath, manifest);

  const dryRun = hasFlag("--dry-run");
  const stageArgs = [
    "--manifest",
    manifestPath,
    "--output-dir",
    stageDir,
  ];
  for (const flag of ["--books-root", "--books-host", "--qdrant-url", "--qdrant-api-key", "--qdrant-collection", "--qdrant-id-batch-size", "--qdrant-scroll-limit"]) {
    const value = readArg(flag);
    if (value) {
      stageArgs.push(flag, value);
    }
  }
  for (const flag of ["--skip-books", "--skip-vectors"]) {
    if (hasFlag(flag)) {
      stageArgs.push(flag);
    }
  }

  const provisionArgs = [
    "--manifest",
    manifestPath,
    "--stage-dir",
    stageDir,
  ];
  for (const flag of ["--fly-app", "--fly-org", "--fly-region", "--fly-image", "--machine-name", "--volume-name", "--volume-size-gb", "--mount-path", "--runtime-shared-token"]) {
    const value = readArg(flag);
    if (value) {
      provisionArgs.push(flag, value);
    }
  }
  for (const flag of ["--skip-service", "--dry-run"]) {
    if (hasFlag(flag)) {
      provisionArgs.push(flag);
    }
  }

  if (dryRun) {
    printJson({
      ok: true,
      dryRun: true,
      shardId,
      manifestPath,
      stageDir,
      selectedGutenbergIds: manifest.selectedGutenbergIds.length,
      stageCommand: ["node", "--import", "tsx", "packages/tooling/scripts/stage-distributed-shard.ts", ...stageArgs],
      provisionCommand: ["node", "--import", "tsx", "packages/tooling/scripts/provision-distributed-shard-machine.ts", ...provisionArgs],
    });
    return;
  }

  await runStreamingCommand("node", ["--import", "tsx", "packages/tooling/scripts/stage-distributed-shard.ts", ...stageArgs]);
  await runStreamingCommand("node", ["--import", "tsx", "packages/tooling/scripts/provision-distributed-shard-machine.ts", ...provisionArgs]);

  printJson({
    ok: true,
    shardId,
    manifestPath,
    stageDir,
  });
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack || error.message : String(error));
  process.exit(1);
});
