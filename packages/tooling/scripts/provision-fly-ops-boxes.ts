import { loadLocalDevVars } from "@alphabook/db";
import { spawn, type ChildProcess } from "node:child_process";

import {
  hasFlag,
  printJson,
  readArg,
  runCommand,
  runStreamingCommand,
} from "./lib/distributed-run";

type CopyItem = {
  sourcePath: string;
  description: string;
};

type BoxRole = "hermes" | "qdrant";

type BoxSpec = {
  role: BoxRole;
  appName: string;
  machineName: string;
  volumeName: string;
  volumeSizeGb: number;
  sourceHost: string;
  sourceKeyOnJumpHost: string;
  copyItems: CopyItem[];
  symlinks: Array<{ linkPath: string; targetPath: string }>;
};

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

const DEFAULT_FLY_ORG = "master-maker";
const DEFAULT_FLY_REGION = "iad";
const DEFAULT_JUMP_HOST = "root@134.209.116.167";
const DEFAULT_MACHINE_IMAGE = "ubuntu:24.04";
const DEFAULT_CPU_KIND = "shared";
const DEFAULT_CPU_COUNT = 2;
const DEFAULT_MEMORY_MB = 4096;
const DEFAULT_DATA_ROOT = "/data";
const DEFAULT_ROOTFS_SIZE = "20gb";

function usage() {
  process.stdout.write(
    [
      "Usage: node --import tsx packages/tooling/scripts/provision-fly-ops-boxes.ts [options]",
      "",
      "Creates cold-standby Fly Machines that duplicate the live DigitalOcean Hermes/Codex and Qdrant boxes.",
      "",
      "Options:",
      "  --role <all|hermes|qdrant>        Which box to provision (default: all)",
      "  --fly-org <master-maker>          Fly organization slug",
      "  --fly-region <iad>                Fly region",
      "  --jump-host <root@host>           Public host that can reach the private source boxes",
      "  --machine-image <ubuntu:24.04>    Base image for the standby box",
      "  --skip-sync                       Only create/update the Fly apps, volumes, and machines",
      "  --dry-run                         Print the plan without making changes",
      "",
      "Per-role overrides:",
      "  --hermes-app <name>",
      "  --hermes-machine <name>",
      "  --hermes-volume <name>",
      "  --hermes-volume-size-gb <300>",
      "  --hermes-source-host <root@10.116.0.2>",
      "  --hermes-source-key </root/.ssh/hermes_consolidate>",
      "  --qdrant-app <name>",
      "  --qdrant-machine <name>",
      "  --qdrant-volume <name>",
      "  --qdrant-volume-size-gb <500>",
      "  --qdrant-source-host <root@10.116.0.4>",
      "  --qdrant-source-key </root/.ssh/hermes_consolidate>",
    ].join("\n") + "\n",
  );
}

function resolveRoleSelection(): BoxRole[] {
  const requested = (readArg("--role") ?? "all").trim().toLowerCase();
  if (requested === "all") {
    return ["hermes", "qdrant"];
  }
  if (requested === "hermes" || requested === "qdrant") {
    return [requested];
  }
  throw new Error(`Unsupported --role value: ${requested}`);
}

function parseOptionalPositiveInt(flagName: string, fallback: number): number {
  const rawValue = readArg(flagName);
  if (!rawValue) {
    return fallback;
  }
  const parsed = Number(rawValue);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`${flagName} must be a positive integer.`);
  }
  return parsed;
}

function buildBoxSpecs(): BoxSpec[] {
  const requestedRoles = new Set(resolveRoleSelection());
  const hermes: BoxSpec = {
    role: "hermes",
    appName: readArg("--hermes-app") ?? "alphabook-hermes-box",
    machineName: readArg("--hermes-machine") ?? "alphabook-hermes-box",
    volumeName: readArg("--hermes-volume") ?? "alphabook-hermes-data",
    volumeSizeGb: parseOptionalPositiveInt("--hermes-volume-size-gb", 300),
    sourceHost: readArg("--hermes-source-host") ?? "root@10.116.0.2",
    sourceKeyOnJumpHost: readArg("--hermes-source-key") ?? "/root/.ssh/hermes_consolidate",
    copyItems: [
      { sourcePath: "/srv/alphabook", description: "Hermes/Codex repo, corpus mirror, and logs" },
      { sourcePath: "/root/alphabook-prepared", description: "Prepared shard outputs under /root" },
      { sourcePath: "/root/restart_shard.sh", description: "Hermes helper" },
      { sourcePath: "/root/run-backfill-remaining-part2.sh", description: "Hermes helper" },
      { sourcePath: "/root/start_prep_workers.sh", description: "Hermes helper" },
      { sourcePath: "/root/start_prep_workers_env.sh", description: "Hermes helper" },
      { sourcePath: "/etc/systemd/system/alphabook-hermes-job-api.service", description: "Hermes job API unit" },
      { sourcePath: "/etc/systemd/system/alphabook-openai-logging-proxy.service", description: "OpenAI logging proxy unit" },
    ],
    symlinks: [
      { linkPath: "/srv/alphabook", targetPath: "/data/srv/alphabook" },
      { linkPath: "/root/alphabook-prepared", targetPath: "/data/root/alphabook-prepared" },
    ],
  };
  const qdrant: BoxSpec = {
    role: "qdrant",
    appName: readArg("--qdrant-app") ?? "alphabook-qdrant-box",
    machineName: readArg("--qdrant-machine") ?? "alphabook-qdrant-box",
    volumeName: readArg("--qdrant-volume") ?? "alphabook-qdrant-data",
    volumeSizeGb: parseOptionalPositiveInt("--qdrant-volume-size-gb", 500),
    sourceHost: readArg("--qdrant-source-host") ?? "root@10.116.0.4",
    sourceKeyOnJumpHost: readArg("--qdrant-source-key") ?? "/root/.ssh/hermes_consolidate",
    copyItems: [
      { sourcePath: "/srv/alphabook", description: "Qdrant box repo and mirror copy" },
      { sourcePath: "/var/lib/qdrant", description: "Live Qdrant storage and snapshots" },
      { sourcePath: "/mnt/alphabook_qdrant_probe_100", description: "Mounted consolidation data root" },
      { sourcePath: "/root/alphabook-prepared", description: "Prepared shard outputs under /root" },
      { sourcePath: "/root/consolidate-prepared-gutenberg-shards.sh", description: "Qdrant helper" },
      { sourcePath: "/root/qdrant-split-plan.json", description: "Qdrant split plan" },
      { sourcePath: "/root/restart_shard.sh", description: "Qdrant helper" },
      { sourcePath: "/root/run-backfill-remaining-part3.sh", description: "Qdrant helper" },
      { sourcePath: "/root/split_remaining_qdrant.mjs", description: "Qdrant helper" },
      { sourcePath: "/root/split_restart_qdrant.mjs", description: "Qdrant helper" },
      { sourcePath: "/root/start_qdrant_workers.sh", description: "Qdrant helper" },
      { sourcePath: "/root/start_split_shard.sh", description: "Qdrant helper" },
    ],
    symlinks: [
      { linkPath: "/srv/alphabook", targetPath: "/data/srv/alphabook" },
      { linkPath: "/var/lib/qdrant", targetPath: "/data/var/lib/qdrant" },
      { linkPath: "/mnt/alphabook_qdrant_probe_100", targetPath: "/data/mnt/alphabook_qdrant_probe_100" },
      { linkPath: "/root/alphabook-prepared", targetPath: "/data/root/alphabook-prepared" },
    ],
  };
  return [hermes, qdrant].filter((spec) => requestedRoles.has(spec.role));
}

async function appExists(appName: string): Promise<boolean> {
  const result = await runCommand("flyctl", ["status", "-a", appName, "-j"], { allowNonZero: true });
  return result.exitCode === 0;
}

async function ensureFlyApp(appName: string, org: string): Promise<void> {
  if (await appExists(appName)) {
    return;
  }
  await runStreamingCommand("flyctl", ["apps", "create", appName, "--org", org, "--yes"]);
}

async function listFlyVolumes(appName: string): Promise<FlyVolumeRecord[]> {
  const { stdout } = await runCommand("flyctl", ["volumes", "list", "-a", appName, "--json"]);
  return JSON.parse(stdout) as FlyVolumeRecord[];
}

async function listFlyMachines(appName: string): Promise<FlyMachineRecord[]> {
  const { stdout } = await runCommand("flyctl", ["machine", "list", "-a", appName, "--json"]);
  return JSON.parse(stdout) as FlyMachineRecord[];
}

async function ensureFlyVolume(spec: BoxSpec, region: string): Promise<FlyVolumeRecord> {
  const existing = (await listFlyVolumes(spec.appName)).find((volume) => volume.name === spec.volumeName);
  if (existing) {
    return existing;
  }
  await runStreamingCommand("flyctl", [
    "volumes",
    "create",
    spec.volumeName,
    "--app",
    spec.appName,
    "--region",
    region,
    "--size",
    String(spec.volumeSizeGb),
    "--yes",
  ]);
  const created = (await listFlyVolumes(spec.appName)).find((volume) => volume.name === spec.volumeName);
  if (!created) {
    throw new Error(`Failed to create volume ${spec.volumeName} for ${spec.role}.`);
  }
  return created;
}

async function ensureFlyMachine(spec: BoxSpec, region: string, machineImage: string): Promise<FlyMachineRecord> {
  const existing = (await listFlyMachines(spec.appName)).find((machine) => machine.name === spec.machineName);
  if (existing) {
    return existing;
  }
  await runStreamingCommand("flyctl", [
    "machine",
    "run",
    machineImage,
    "--app",
    spec.appName,
    "--name",
    spec.machineName,
    "--region",
    region,
    "--detach",
    "--restart",
    "always",
    "--vm-cpu-kind",
    DEFAULT_CPU_KIND,
    "--vm-cpus",
    String(DEFAULT_CPU_COUNT),
    "--vm-memory",
    String(DEFAULT_MEMORY_MB),
    "--rootfs-persist",
    "always",
    "--rootfs-size",
    DEFAULT_ROOTFS_SIZE,
    "--volume",
    `${spec.volumeName}:${DEFAULT_DATA_ROOT}`,
    "--env",
    `BOX_ROLE=${spec.role}`,
    "--env",
    `BOX_DATA_ROOT=${DEFAULT_DATA_ROOT}`,
    "--entrypoint",
    "/bin/bash",
    "-lc",
    "trap 'exit 0' TERM INT; while true; do sleep 3600; done",
  ]);
  const created = (await listFlyMachines(spec.appName)).find((machine) => machine.name === spec.machineName);
  if (!created) {
    throw new Error(`Failed to create machine ${spec.machineName} for ${spec.role}.`);
  }
  return created;
}

async function runFlyCommand(spec: BoxSpec, machineId: string, command: string): Promise<void> {
  await runStreamingCommand("flyctl", [
    "ssh",
    "console",
    "--app",
    spec.appName,
    "--machine",
    machineId,
    "--command",
    command,
  ]);
}

async function seedMachineLayout(spec: BoxSpec, machineId: string): Promise<void> {
  const commands = [
    `mkdir -p ${DEFAULT_DATA_ROOT}`,
    "mkdir -p /srv /var/lib /mnt /root",
    ...spec.symlinks.map(({ linkPath, targetPath }) => [
      `mkdir -p "$(dirname ${shellQuote(targetPath)})"`,
      `mkdir -p "$(dirname ${shellQuote(linkPath)})"`,
      `[ -L ${shellQuote(linkPath)} ] || [ -e ${shellQuote(linkPath)} ] || ln -s ${shellQuote(targetPath)} ${shellQuote(linkPath)}`,
    ].join(" && ")),
  ].join(" && ");
  await runFlyCommand(spec, machineId, commands);
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\"'\"'`)}'`;
}

function relativeFromRoot(sourcePath: string): string {
  return sourcePath.replace(/^\/+/u, "");
}

async function streamCopyItem(spec: BoxSpec, machineId: string, jumpHost: string, item: CopyItem): Promise<void> {
  const relativePath = relativeFromRoot(item.sourcePath);
  const sourceCommand = [
    "bash",
    "-lc",
    [
      `ssh -i ${shellQuote(spec.sourceKeyOnJumpHost)} ${shellQuote(spec.sourceHost)}`,
      shellQuote(
        `test -e ${item.sourcePath} && cd / && tar --xattrs --numeric-owner -cpf - ${relativePath}`,
      ),
    ].join(" "),
  ];

  const sourceChild = spawn("ssh", [jumpHost, ...sourceCommand], {
    stdio: ["ignore", "pipe", "pipe"],
  });
  const targetChild = spawn(
    "flyctl",
    [
      "ssh",
      "console",
      "--app",
      spec.appName,
      "--machine",
      machineId,
      "--command",
      `mkdir -p ${DEFAULT_DATA_ROOT} && cd ${DEFAULT_DATA_ROOT} && tar -xpf -`,
    ],
    {
      stdio: ["pipe", "inherit", "inherit"],
    },
  );

  sourceChild.stdout.pipe(targetChild.stdin);

  const [sourceExitCode, targetExitCode] = await Promise.all([
    waitForChild(sourceChild, `source transfer for ${item.sourcePath}`),
    waitForChild(targetChild, `Fly transfer for ${item.sourcePath}`),
  ]);
  if (sourceExitCode !== 0 || targetExitCode !== 0) {
    throw new Error(`Transfer failed for ${item.sourcePath}. Source exit=${sourceExitCode}, target exit=${targetExitCode}`);
  }
}

async function waitForChild(
  child: ChildProcess,
  label: string,
): Promise<number> {
  return await new Promise((resolvePromise, reject) => {
    let stderr = "";
    child.stderr?.on("data", (chunk) => {
      stderr += String(chunk);
    });
    child.on("error", reject);
    child.on("exit", (code) => {
      const exitCode = code ?? -1;
      if (exitCode !== 0) {
        reject(new Error(`${label} exited with code ${exitCode}${stderr.trim() ? `\n${stderr.trim()}` : ""}`));
        return;
      }
      resolvePromise(exitCode);
    });
  });
}

async function syncBox(spec: BoxSpec, machineId: string, jumpHost: string): Promise<void> {
  for (const item of spec.copyItems) {
    process.stdout.write(`[${spec.role}] copying ${item.sourcePath} (${item.description})\n`);
    await streamCopyItem(spec, machineId, jumpHost, item);
  }
}

async function main() {
  if (hasFlag("--help")) {
    usage();
    return;
  }

  await loadLocalDevVars(process.cwd());
  process.env.FLY_ACCESS_TOKEN = process.env.FLY_ACCESS_TOKEN ?? process.env.FLY_API_TOKEN;

  const flyOrg = readArg("--fly-org") ?? process.env.FLY_ORG ?? DEFAULT_FLY_ORG;
  const flyRegion = readArg("--fly-region") ?? DEFAULT_FLY_REGION;
  const jumpHost = readArg("--jump-host") ?? DEFAULT_JUMP_HOST;
  const machineImage = readArg("--machine-image") ?? DEFAULT_MACHINE_IMAGE;
  const skipSync = hasFlag("--skip-sync");
  const dryRun = hasFlag("--dry-run");
  const specs = buildBoxSpecs();

  const plan = specs.map((spec) => ({
    role: spec.role,
    appName: spec.appName,
    machineName: spec.machineName,
    volumeName: spec.volumeName,
    volumeSizeGb: spec.volumeSizeGb,
    sourceHost: spec.sourceHost,
    sourceKeyOnJumpHost: spec.sourceKeyOnJumpHost,
    copyItems: spec.copyItems.map((item) => item.sourcePath),
  }));
  if (dryRun) {
    printJson({
      ok: true,
      dryRun: true,
      flyOrg,
      flyRegion,
      jumpHost,
      machineImage,
      skipSync,
      plan,
    });
    return;
  }

  const results: Array<Record<string, unknown>> = [];
  for (const spec of specs) {
    await ensureFlyApp(spec.appName, flyOrg);
    const volume = await ensureFlyVolume(spec, flyRegion);
    const machine = await ensureFlyMachine(spec, flyRegion, machineImage);
    await seedMachineLayout(spec, machine.id);
    if (!skipSync) {
      await syncBox(spec, machine.id, jumpHost);
      await seedMachineLayout(spec, machine.id);
    }
    results.push({
      role: spec.role,
      appName: spec.appName,
      machineId: machine.id,
      machineName: spec.machineName,
      volumeId: volume.id,
      volumeName: volume.name,
      synced: !skipSync,
    });
  }
  printJson({ ok: true, results });
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack || error.message : String(error));
  process.exit(1);
});
