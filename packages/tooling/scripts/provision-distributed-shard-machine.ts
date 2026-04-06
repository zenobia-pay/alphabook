import { loadLocalDevVars } from "@alphabook/db";

import type { DistributedShardManifest } from "./lib/distributed-run";
import {
  hasFlag,
  pathExists,
  printJson,
  readArg,
  readJsonFile,
  requireFile,
  runCommand,
  runStreamingCommand,
} from "./lib/distributed-run";

type FlyMachineRecord = {
  id: string;
  name?: string;
  state?: string;
};

type FlyVolumeRecord = {
  id: string;
  name: string;
  region: string;
  state: string;
};

const DEFAULT_FLY_APP = "alphabook-distributed-run";
const DEFAULT_FLY_REGION = "iad";
const DEFAULT_VOLUME_SIZE_GB = 50;
const DEFAULT_CPU_KIND = "shared";
const DEFAULT_CPU_COUNT = 2;
const DEFAULT_MEMORY_MB = 4096;
const DEFAULT_MOUNT_PATH = "/data";

function usage() {
  process.stdout.write(
    [
      "Usage: node --import tsx packages/tooling/scripts/provision-distributed-shard-machine.ts --manifest <path> [options]",
      "",
      "Options:",
      "  --stage-dir <path>",
      "  --fly-app <alphabook-distributed-run>",
      "  --fly-org <org>",
      "  --fly-region <iad>",
      "  --fly-image <registry.fly.io/alphabook-runtime:...>",
      "  --machine-name <alphabook-shard-0001>",
      "  --volume-name <data-shard-0001>",
      "  --volume-size-gb <50>",
      "  --mount-path </data>",
      "  --runtime-shared-token <token>",
      "  --skip-service",
      "  --dry-run",
    ].join("\n") + "\n",
  );
}

async function appExists(appName: string): Promise<boolean> {
  const result = await runCommand("flyctl", ["status", "-a", appName, "-j"], { allowNonZero: true });
  return result.exitCode === 0;
}

async function ensureFlyApp(appName: string, org: string | null) {
  if (await appExists(appName)) {
    return;
  }
  const args = ["apps", "create", appName, "--yes"];
  if (org) {
    args.push("--org", org);
  }
  await runStreamingCommand("flyctl", args);
}

async function listFlyMachines(appName: string): Promise<FlyMachineRecord[]> {
  const { stdout } = await runCommand("flyctl", ["machine", "list", "-a", appName, "--json"]);
  return JSON.parse(stdout) as FlyMachineRecord[];
}

async function listFlyVolumes(appName: string): Promise<FlyVolumeRecord[]> {
  const { stdout } = await runCommand("flyctl", ["volumes", "list", "-a", appName, "--json"]);
  return JSON.parse(stdout) as FlyVolumeRecord[];
}

async function ensureFlyVolume(options: {
  appName: string;
  volumeName: string;
  region: string;
  sizeGb: number;
}) {
  const existing = (await listFlyVolumes(options.appName)).find((volume) => volume.name === options.volumeName);
  if (existing) {
    return existing;
  }
  await runStreamingCommand("flyctl", [
    "volumes",
    "create",
    options.volumeName,
    "--app",
    options.appName,
    "--region",
    options.region,
    "--size",
    String(options.sizeGb),
    "--yes",
  ]);
  const created = (await listFlyVolumes(options.appName)).find((volume) => volume.name === options.volumeName);
  if (!created) {
    throw new Error(`Failed to create volume ${options.volumeName}.`);
  }
  return created;
}

async function ensureFlyMachine(options: {
  appName: string;
  image: string;
  machineName: string;
  region: string;
  volumeName: string;
  mountPath: string;
  runtimeSharedToken: string | null;
  skipService: boolean;
}) {
  const existing = (await listFlyMachines(options.appName)).find((machine) => machine.name === options.machineName);
  if (existing) {
    return existing;
  }
  const args = [
    "machine",
    "run",
    options.image,
    ...(options.skipService ? ["/bin/sh", "-lc", "sleep infinity"] : []),
    "--app",
    options.appName,
    "--name",
    options.machineName,
    "--region",
    options.region,
    "--detach",
    "--restart",
    "always",
    "--vm-cpu-kind",
    DEFAULT_CPU_KIND,
    "--vm-cpus",
    String(DEFAULT_CPU_COUNT),
    "--vm-memory",
    String(DEFAULT_MEMORY_MB),
    "--volume",
    `${options.volumeName}:${options.mountPath}`,
    "--env",
    `RUNTIME_WORKSPACE_ROOT=/workspace`,
  ];
  if (!options.skipService) {
    if (!options.runtimeSharedToken) {
      throw new Error("Provisioning a runtime-backed machine requires --runtime-shared-token or RUNTIME_SHARED_TOKEN.");
    }
    args.push("--env", `RUNTIME_SHARED_TOKEN=${options.runtimeSharedToken}`);
    args.push("--port", "8080/tcp:http");
  }
  await runStreamingCommand("flyctl", args);
  const created = (await listFlyMachines(options.appName)).find((machine) => machine.name === options.machineName);
  if (!created) {
    throw new Error(`Failed to create machine ${options.machineName}.`);
  }
  return created;
}

async function uploadShardToMachine(options: {
  appName: string;
  machineId: string;
  mountPath: string;
  shardId: string;
  stageDir: string;
}) {
  const remoteBaseDir = `${options.mountPath}/distributed-run`;
  const remoteTargetDir = `${remoteBaseDir}/${options.shardId}`;
  await runStreamingCommand("flyctl", [
    "ssh",
    "console",
    "--app",
    options.appName,
    "--machine",
    options.machineId,
    "--command",
    `mkdir -p ${remoteBaseDir} && rm -rf ${remoteTargetDir} && mkdir -p ${remoteTargetDir}/books ${remoteTargetDir}/vectors`,
  ]);
  const uploads = [
    { localPath: `${options.stageDir}/books`, remotePath: `${remoteTargetDir}/books`, recursive: true },
    { localPath: `${options.stageDir}/vectors`, remotePath: `${remoteTargetDir}/vectors`, recursive: true },
    { localPath: `${options.stageDir}/manifest.json`, remotePath: `${remoteTargetDir}/manifest.json`, recursive: false },
    { localPath: `${options.stageDir}/gutenberg-ids.txt`, remotePath: `${remoteTargetDir}/gutenberg-ids.txt`, recursive: false },
  ];
  for (const upload of uploads) {
    if (!await pathExists(upload.localPath)) {
      continue;
    }
    await runStreamingCommand("flyctl", [
      "ssh",
      "sftp",
      "put",
      ...(upload.recursive ? ["-R"] : []),
      upload.localPath,
      upload.remotePath,
      "--app",
      options.appName,
      "--machine",
      options.machineId,
    ]);
  }
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
  const stageDir = readArg("--stage-dir") ?? `output/distributed-run/${manifest.shardId}/stage`;
  if (!await pathExists(stageDir)) {
    throw new Error(`Stage directory does not exist: ${stageDir}`);
  }

  const appName = readArg("--fly-app") ?? process.env.FLY_DISTRIBUTED_APP ?? DEFAULT_FLY_APP;
  const org = readArg("--fly-org") ?? process.env.FLY_ORG ?? null;
  const region = readArg("--fly-region") ?? process.env.FLY_RUNTIME_REGION ?? DEFAULT_FLY_REGION;
  const image = readArg("--fly-image") ?? process.env.FLY_DISTRIBUTED_IMAGE ?? process.env.FLY_RUNTIME_IMAGE ?? null;
  if (!image) {
    throw new Error("Provisioning requires --fly-image or FLY_DISTRIBUTED_IMAGE/FLY_RUNTIME_IMAGE.");
  }
  const machineName = readArg("--machine-name") ?? `alphabook-${manifest.shardId}`;
  const volumeName = readArg("--volume-name") ?? `data-${manifest.shardId}`;
  const mountPath = readArg("--mount-path") ?? DEFAULT_MOUNT_PATH;
  const runtimeSharedToken = readArg("--runtime-shared-token") ?? process.env.RUNTIME_SHARED_TOKEN ?? process.env.FLY_RUNTIME_SHARED_TOKEN ?? null;
  const skipService = hasFlag("--skip-service");
  const dryRun = hasFlag("--dry-run");

  const plan = {
    appName,
    org,
    region,
    image,
    machineName,
    volumeName,
    mountPath,
    stageDir,
    shardId: manifest.shardId,
    skipService,
  };
  if (dryRun) {
    printJson({ ok: true, dryRun: true, plan });
    return;
  }

  await ensureFlyApp(appName, org);
  const volume = await ensureFlyVolume({
    appName,
    volumeName,
    region,
    sizeGb: Number(readArg("--volume-size-gb") ?? DEFAULT_VOLUME_SIZE_GB),
  });
  const machine = await ensureFlyMachine({
    appName,
    image,
    machineName,
    region,
    volumeName: volume.name,
    mountPath,
    runtimeSharedToken,
    skipService,
  });
  await uploadShardToMachine({
    appName,
    machineId: machine.id,
    mountPath,
    shardId: manifest.shardId,
    stageDir,
  });

  printJson({
    ok: true,
    shardId: manifest.shardId,
    appName,
    machineId: machine.id,
    machineName,
    volumeId: volume.id,
    volumeName: volume.name,
    remotePath: `${mountPath}/distributed-run/${manifest.shardId}`,
  });
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack || error.message : String(error));
  process.exit(1);
});
