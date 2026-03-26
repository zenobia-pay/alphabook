import { spawnSync } from "node:child_process";

import { D1_SCHEMA_SQL, splitMigrationStatements } from "../packages/db/src/index";

const databaseName = process.argv[2] ?? process.env.D1_DATABASE_NAME ?? "alphabook-app";
const statements = splitMigrationStatements(D1_SCHEMA_SQL);

for (const statement of statements) {
  const result = spawnSync(
    "npx",
    ["wrangler", "d1", "execute", databaseName, "--remote", "--command", statement],
    {
      cwd: process.cwd(),
      stdio: "pipe",
      encoding: "utf8",
      shell: process.platform === "win32",
      env: process.env,
    },
  );

  if (result.status !== 0) {
    process.stderr.write(result.stdout);
    process.stderr.write(result.stderr);
    throw new Error(`Failed statement: ${statement}`);
  }
}

process.stdout.write(`Applied ${statements.length} D1 statements to ${databaseName}.\n`);
