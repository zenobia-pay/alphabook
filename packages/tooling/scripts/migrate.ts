import process from "node:process";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

import { runPostgresMigrations } from "@alphabook/db";

async function loadEnvFile(path: string) {
  try {
    const envText = await readFile(path, "utf8");
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
    // Optional local env file.
  }
}

async function main() {
  await loadEnvFile(resolve(process.cwd(), ".env"));
  await loadEnvFile(resolve(process.cwd(), ".env.local"));

  if (!process.env.DATABASE_URL) {
    throw new Error("DATABASE_URL is required. Linux deployments no longer fall back to Wrangler/D1 migrations.");
  }
  await runPostgresMigrations({ connectionString: process.env.DATABASE_URL });
  console.log("Applied AlphaBook schema to Postgres.");
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
