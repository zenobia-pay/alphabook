import process from "node:process";
import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

import { createPostgresDb, D1_SCHEMA_SQL } from "@alphabook/db";

type TableExportConfig = {
  name: string;
  selectSql?: string;
  orderBy?: string;
  batchSize?: number;
  transformRow?: (row: Record<string, unknown>) => Record<string, unknown>;
};

const TABLES: TableExportConfig[] = [
  { name: "users", orderBy: "id", batchSize: 5_000 },
  { name: "chat_sessions", orderBy: "created_at, id", batchSize: 5_000 },
  { name: "messages", orderBy: "created_at, id", batchSize: 5_000 },
  { name: "runs", orderBy: "started_at, id", batchSize: 5_000 },
  { name: "tool_calls", orderBy: "started_at, id", batchSize: 5_000 },
  { name: "run_events", orderBy: "run_id, sequence, created_at, id", batchSize: 250 },
  { name: "authors", orderBy: "name, id", batchSize: 5_000 },
  { name: "works", orderBy: "created_at, id", batchSize: 2_000 },
  { name: "work_authors", orderBy: "work_id, author_id" },
  { name: "subjects", orderBy: "label, id", batchSize: 5_000 },
  { name: "work_subjects", orderBy: "work_id, subject_id" },
  { name: "work_files", orderBy: "created_at, id", batchSize: 2_000 },
  {
    name: "chunks",
    selectSql: "SELECT id, work_id, chunk_index, text, r2_key, metadata_json, created_at FROM chunks",
    orderBy: "work_id, chunk_index, id",
    batchSize: 200,
  },
  { name: "runtime_instances", orderBy: "created_at, id", batchSize: 25 },
  { name: "artifacts", orderBy: "created_at, id", batchSize: 250 },
  { name: "jobs", orderBy: "created_at, id", batchSize: 500 },
  { name: "notifications", orderBy: "created_at, id", batchSize: 5_000 },
  { name: "user_follows", orderBy: "created_at, follower_id, followed_id" },
  { name: "billing_events", orderBy: "created_at, id", batchSize: 5_000 },
  { name: "analytics_events", orderBy: "created_at, id", batchSize: 5_000 },
  { name: "agent_identities", orderBy: "created_at, id", batchSize: 2_000 },
  {
    name: "feed_works",
    orderBy: "rank, work_id",
    batchSize: 2_000,
    transformRow(row) {
      const next = { ...row };
      if (Array.isArray(next.authors)) {
        next.authors_json = JSON.stringify(next.authors);
        delete next.authors;
      }
      if (Array.isArray(next.subjects)) {
        next.subjects_json = JSON.stringify(next.subjects);
        delete next.subjects;
      }
      return next;
    },
  },
  { name: "site_stats", orderBy: "key", batchSize: 100 },
];

const APP_STATE_TABLES = new Set([
  "users",
  "chat_sessions",
  "messages",
  "runs",
  "tool_calls",
  "run_events",
  "runtime_instances",
  "artifacts",
  "jobs",
  "notifications",
  "user_follows",
  "billing_events",
  "analytics_events",
  "agent_identities",
]);

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
      process.env[key] = rawValue.trim().replace(/^"(.*)"$/u, "$1").replace(/^'(.*)'$/u, "$1");
    }
  } catch {
    // Optional local env loading.
  }
}

function sqlIdentifier(name: string) {
  return `"${name.replace(/"/g, "\"\"")}"`;
}

function sqlLiteral(value: unknown): string {
  if (value === null || value === undefined) {
    return "NULL";
  }
  if (typeof value === "number") {
    return Number.isFinite(value) ? String(value) : "NULL";
  }
  if (typeof value === "boolean") {
    return value ? "1" : "0";
  }
  if (value instanceof Date) {
    return `'${value.toISOString().replace(/'/g, "''")}'`;
  }
  if (Array.isArray(value) || (typeof value === "object" && value !== null)) {
    return `'${JSON.stringify(value).replace(/'/g, "''")}'`;
  }
  return `'${String(value).replace(/'/g, "''")}'`;
}

function insertStatements(tableName: string, rows: Record<string, unknown>[]): string[] {
  if (rows.length === 0) {
    return [];
  }
  const columns = Object.keys(rows[0]);
  const columnSql = columns.map(sqlIdentifier).join(", ");
  return rows.map((row) => {
    const values = columns.map((column) => sqlLiteral(row[column])).join(", ");
    return `INSERT INTO ${sqlIdentifier(tableName)} (${columnSql}) VALUES (${values});`;
  });
}

async function streamTableToFile(
  db: ReturnType<typeof createPostgresDb>,
  config: TableExportConfig,
  outputPath: string,
): Promise<number> {
  const orderBy = config.orderBy ? ` ORDER BY ${config.orderBy}` : "";
  const batchSize = Math.max(1, config.batchSize ?? 2_000);
  const baseQuery = config.selectSql ?? `SELECT * FROM ${config.name}`;
  let offset = 0;
  let totalRows = 0;

  console.log(`Exporting ${config.name}...`);
  for (;;) {
    const query = `${baseQuery}${orderBy} LIMIT ${batchSize} OFFSET ${offset}`;
    const result = await db.query<Record<string, unknown>>(query);
    const rows = config.transformRow
      ? result.rows.map((row) => config.transformRow!(row))
      : result.rows;
    if (rows.length === 0) {
      console.log(`  ${config.name}: fetched ${totalRows} rows`);
      break;
    }

    const statements = insertStatements(config.name, rows);
    if (statements.length > 0) {
      await appendFile(outputPath, `${statements.join("\n")}\n`, "utf8");
    }
    totalRows += rows.length;
    console.log(`  ${config.name}: fetched ${totalRows} rows`);

    if (result.rows.length < batchSize) {
      break;
    }
    offset += batchSize;
  }

  return totalRows;
}

async function main() {
  await loadLocalEnvFile();
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    throw new Error("DATABASE_URL is required.");
  }

  const scopeArg = process.argv.find((value) => value.startsWith("--scope="));
  const scope = scopeArg?.split("=", 2)[1] === "app" ? "app" : "all";
  const outputArg = process.argv.slice(2).find((value) => !value.startsWith("--"));
  const outputPath = resolve(process.cwd(), outputArg ?? "tmp/alphabook-d1-migration.sql");
  const selectedTables = scope === "app"
    ? TABLES.filter((table) => APP_STATE_TABLES.has(table.name))
    : TABLES;

  await mkdir(dirname(outputPath), { recursive: true });
  await writeFile(
    outputPath,
    [
      `-- Generated by packages/tooling/scripts/export-postgres-to-d1-sql.ts (scope=${scope})`,
      "PRAGMA foreign_keys = OFF;",
      "BEGIN TRANSACTION;",
      D1_SCHEMA_SQL.trim(),
      ...[...selectedTables].reverse().map((table) => `DELETE FROM ${sqlIdentifier(table.name)};`),
      "",
    ].join("\n"),
    "utf8",
  );

  const db = createPostgresDb(connectionString);
  try {
    const summary: string[] = [];
    for (const table of selectedTables) {
      try {
        const count = await streamTableToFile(db, table, outputPath);
        summary.push(`${table.name}:${count}`);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error ?? "");
        if (/does not exist/i.test(message)) {
          continue;
        }
        throw error;
      }
    }
    await appendFile(outputPath, "COMMIT;\nPRAGMA foreign_keys = ON;\n", "utf8");
    console.log(`Wrote D1 migration SQL to ${outputPath}`);
    console.log(summary.join(", "));
  } finally {
    await db.end();
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
