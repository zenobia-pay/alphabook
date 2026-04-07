import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";

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

function parseEnvFile(filePath: string) {
  const values = new Map<string, string>();
  const raw = fs.readFileSync(filePath, "utf8");
  for (const line of raw.split(/\r?\n/u)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) {
      continue;
    }
    const separatorIndex = trimmed.indexOf("=");
    if (separatorIndex <= 0) {
      continue;
    }
    const key = trimmed.slice(0, separatorIndex).trim();
    const value = trimmed.slice(separatorIndex + 1).trim();
    if (!key) {
      continue;
    }
    if (
      (value.startsWith("\"") && value.endsWith("\""))
      || (value.startsWith("'") && value.endsWith("'"))
    ) {
      values.set(key, value.slice(1, -1));
      continue;
    }
    values.set(key, value);
  }
  return values;
}

function resolveEnvFile(configPath: string, explicitPath?: string) {
  if (explicitPath) {
    return path.resolve(explicitPath);
  }
  const searchRoots = [
    process.cwd(),
    path.dirname(configPath),
    path.resolve(path.dirname(configPath), ".."),
    path.resolve(path.dirname(configPath), "../.."),
  ];
  for (const root of searchRoots) {
    for (const candidate of [".dev.vars", ".dev.vars.codexrun"]) {
      const resolved = path.resolve(root, candidate);
      if (fs.existsSync(resolved)) {
        return resolved;
      }
    }
  }
  throw new Error("Could not find an env file. Pass --env-file explicitly.");
}

function buildSecretPayload(values: Map<string, string>, keys: string[]) {
  const payload: Record<string, string> = {};
  const missing: string[] = [];
  const skippedOptional: string[] = [];
  for (const rawKey of keys) {
    const optional = rawKey.endsWith("?");
    const key = optional ? rawKey.slice(0, -1) : rawKey;
    const value = values.get(key);
    if (!value) {
      if (optional) {
        skippedOptional.push(key);
      } else {
        missing.push(key);
      }
      continue;
    }
    payload[key] = value;
  }
  if (missing.length > 0) {
    throw new Error(`Missing required secrets in env file: ${missing.join(", ")}`);
  }
  return { payload, skippedOptional };
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const configPathArg = args.get("config");
  const envFileArg = args.get("env-file");
  const keysArg = args.get("keys");
  if (!configPathArg || !keysArg) {
    throw new Error("Usage: sync-worker-secrets.ts --config <config.toml> --keys <KEY1,KEY2,...> [--env-file .dev.vars]");
  }

  const configPath = path.resolve(configPathArg);
  const envFile = resolveEnvFile(configPath, envFileArg);
  const envValues = parseEnvFile(envFile);
  const keys = keysArg.split(",").map((value) => value.trim()).filter(Boolean);
  const { payload, skippedOptional } = buildSecretPayload(envValues, keys);
  const tempFile = path.join(os.tmpdir(), `wrangler-secret-bulk-${Date.now()}.json`);

  try {
    if (Object.keys(payload).length > 0) {
      fs.writeFileSync(tempFile, JSON.stringify(payload, null, 2));
      execFileSync("npx", ["wrangler", "secret", "bulk", tempFile, "--config", configPath], {
        stdio: "inherit",
      });
    }
    console.log(JSON.stringify({
      configPath,
      envFile,
      syncedKeys: Object.keys(payload),
      skippedOptional,
    }, null, 2));
  } finally {
    fs.rmSync(tempFile, { force: true });
  }
}

main();
