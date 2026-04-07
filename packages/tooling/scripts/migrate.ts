import process from "node:process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawn } from "node:child_process";

import { D1_SCHEMA_SQL, runPostgresMigrations } from "@alphabook/db";

async function loadLocalEnvFile() {
  try {
    const envText = await readFile(resolve(process.cwd(), ".dev.vars"), "utf8");
    for (const line of envText.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) {
        continue;
      }
      const match = trimmed.match(/^([A-Z0-9_]+)=(.*)$/);
      if (!match) {
        continue;
      }
      const [, key, rawValue] = match;
      if (process.env[key]) {
        continue;
      }
      const value = rawValue.trim().replace(/^"(.*)"$/u, "$1").replace(/^'(.*)'$/u, "$1");
      process.env[key] = value;
    }
  } catch {
    // Local env loading is optional.
  }
}

async function runWrangler(args: string[]) {
  await new Promise<void>((resolvePromise, reject) => {
    const child = spawn("npx", ["wrangler", ...args], {
      stdio: "inherit",
      shell: process.platform === "win32",
    });
    child.on("exit", (code) => {
      if (code === 0) {
        resolvePromise();
        return;
      }
      reject(new Error(`wrangler ${args.join(" ")} exited with code ${code ?? -1}`));
    });
    child.on("error", reject);
  });
}

async function main() {
  await loadLocalEnvFile();

  if (process.env.DATABASE_URL) {
    await runPostgresMigrations({ connectionString: process.env.DATABASE_URL });
    console.log("Applied AlphaBook schema to Postgres.");
    return;
  }

  const databaseName = process.argv[2] ?? process.env.D1_DATABASE_NAME ?? "alphabook-app";
  const remoteFlag = process.argv.includes("--local") ? "--local" : "--remote";

  const tempDir = await mkdtemp(join(tmpdir(), "alphabook-d1-migrate-"));
  const schemaPath = join(tempDir, "schema.sql");
  try {
    await writeFile(schemaPath, `${D1_SCHEMA_SQL.trim()}\n`, "utf8");
    await runWrangler(["d1", "execute", databaseName, remoteFlag, "--file", schemaPath]);
    console.log(`Applied AlphaBook D1 schema to ${databaseName}.`);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
