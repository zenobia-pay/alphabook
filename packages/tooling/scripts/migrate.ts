import process from "node:process";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

import { createNeonDb, runMigrations } from "@alphabook/db";

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

async function main() {
  await loadLocalEnvFile();
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    throw new Error("DATABASE_URL is required.");
  }

  const db = createNeonDb(connectionString);
  try {
    await runMigrations(db);
    console.log("Applied AlphaBook migrations.");
  } finally {
    await db.end();
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
