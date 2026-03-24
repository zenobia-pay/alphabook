import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";

interface FlyRelease {
  Status?: string;
  ImageRef?: string;
  Version?: number;
}

function parseArgs(argv: string[]) {
  const values = new Map<string, string>();
  for (let index = 0; index < argv.length; index += 1) {
    const current = argv[index];
    if (!current.startsWith("--")) {
      continue;
    }
    const next = argv[index + 1];
    if (next && !next.startsWith("--")) {
      values.set(current.slice(2), next);
      index += 1;
      continue;
    }
    values.set(current.slice(2), "true");
  }
  return values;
}

function readLatestImageRef(appName: string): string {
  const raw = execFileSync("fly", ["releases", "-a", appName, "--json"], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "inherit"],
  });
  const releases = JSON.parse(raw) as FlyRelease[];
  const latest = releases.find((release) => release.Status === "complete" && release.ImageRef);
  if (!latest?.ImageRef) {
    throw new Error(`No complete Fly release with an image ref found for app ${appName}.`);
  }
  return latest.ImageRef;
}

function updateWranglerConfig(configPath: string, imageRef: string) {
  const original = fs.readFileSync(configPath, "utf8");
  if (!/^FLY_RUNTIME_IMAGE = ".*"$/m.test(original)) {
    throw new Error(`Could not find FLY_RUNTIME_IMAGE in ${configPath}.`);
  }
  const updated = original.replace(
    /^FLY_RUNTIME_IMAGE = ".*"$/m,
    `FLY_RUNTIME_IMAGE = "${imageRef}"`,
  );
  fs.writeFileSync(configPath, updated);
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const appName = args.get("app");
  const configPathArg = args.get("config");
  if (!appName || !configPathArg) {
    throw new Error("Usage: sync-runtime-image-pin.ts --app <fly-app> --config <wrangler.toml>");
  }
  const configPath = path.resolve(configPathArg);
  const imageRef = readLatestImageRef(appName);
  updateWranglerConfig(configPath, imageRef);
  console.log(JSON.stringify({ appName, configPath, imageRef }, null, 2));
}

main();
