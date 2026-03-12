import process from "node:process";

import { createNeonDb, runMigrations } from "@alphabook/db";

async function main() {
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
