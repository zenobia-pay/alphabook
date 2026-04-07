import process from "node:process";

import { Pool, type PoolConfig } from "pg";

import type { DbClient } from "./index";
import { D1_SCHEMA_SQL } from "./d1-sql";
import { splitMigrationStatements } from "./d1";

export type CreatePostgresDbOptions = {
  connectionString?: string;
  poolConfig?: PoolConfig;
};

function convertJsonPath(path: string) {
  const match = path.match(/^\$\.(.+)$/u);
  if (!match) {
    throw new Error(`Unsupported JSON path ${path}`);
  }
  return match[1].split(".").map((segment) => segment.trim()).filter(Boolean);
}

function buildJsonExtractTextExpression(source: string, path: string) {
  const segments = convertJsonPath(path).map((segment) => `'${segment.replace(/'/gu, "''")}'`).join(", ");
  return `jsonb_extract_path_text((${source})::jsonb, ${segments})`;
}

function buildJsonExtractExpression(source: string, path: string) {
  const segments = convertJsonPath(path).map((segment) => `'${segment.replace(/'/gu, "''")}'`).join(", ");
  return `jsonb_extract_path((${source})::jsonb, ${segments})`;
}

function replaceJsonEach(sql: string) {
  return sql.replace(
    /JOIN\s+json_each\s*\(\s*COALESCE\(\s*json_extract\(\s*([^,]+?)\s*,\s*'(\$\.[^']+)'\s*\)\s*,\s*'(\[\])'\s*\)\s*\)\s+([a-zA-Z_][a-zA-Z0-9_]*)/gu,
    (_match, source: string, path: string, fallback: string, alias: string) =>
      `CROSS JOIN LATERAL jsonb_array_elements_text(COALESCE(${buildJsonExtractExpression(source.trim(), path)}, '${fallback}'::jsonb)) AS ${alias}(value)`,
  ).replace(
    /JOIN\s+json_each\s*\(\s*COALESCE\(\s*([^,()]+?)\s*,\s*'(\[\])'\s*\)\s*\)\s+([a-zA-Z_][a-zA-Z0-9_]*)/gu,
    (_match, source: string, fallback: string, alias: string) =>
      `CROSS JOIN LATERAL jsonb_array_elements_text(COALESCE((${source.trim()})::jsonb, '${fallback}'::jsonb)) AS ${alias}(value)`,
  ).replace(
    /json_each\s*\(\s*COALESCE\(\s*json_extract\(\s*([^,]+?)\s*,\s*'(\$\.[^']+)'\s*\)\s*,\s*'(\[\])'\s*\)\s*\)\s+([a-zA-Z_][a-zA-Z0-9_]*)/gu,
    (_match, source: string, path: string, fallback: string, alias: string) =>
      `jsonb_array_elements_text(COALESCE(${buildJsonExtractExpression(source.trim(), path)}, '${fallback}'::jsonb)) AS ${alias}(value)`,
  ).replace(
    /json_each\s*\(\s*COALESCE\(\s*([^,()]+?)\s*,\s*'(\[\])'\s*\)\s*\)\s+([a-zA-Z_][a-zA-Z0-9_]*)/gu,
    (_match, source: string, fallback: string, alias: string) =>
      `jsonb_array_elements_text(COALESCE((${source.trim()})::jsonb, '${fallback}'::jsonb)) AS ${alias}(value)`,
  );
}

function replaceJsonHelpers(sql: string) {
  let next = sql;
  next = replaceJsonEach(next);
  next = next.replace(
    /json_array_length\s*\(\s*json_extract\(\s*([^,]+?)\s*,\s*'(\$\.[^']+)'\s*\)\s*\)/gu,
    (_match, source: string, path: string) =>
      `jsonb_array_length(COALESCE(${buildJsonExtractExpression(source.trim(), path)}, '[]'::jsonb))`,
  );
  next = next.replace(
    /json_extract\s*\(\s*([^,]+?)\s*,\s*'(\$\.[^']+)'\s*\)/gu,
    (_match, source: string, path: string) => buildJsonExtractTextExpression(source.trim(), path),
  );
  next = next.replace(
    /json_group_array\s*\(\s*DISTINCT\s+([^)]+?)\s*\)/gu,
    (_match, expr: string) => `COALESCE(json_agg(DISTINCT ${expr.trim()}) FILTER (WHERE ${expr.trim()} IS NOT NULL), '[]'::json)::text`,
  );
  return next;
}

function replaceInsertIgnore(sql: string) {
  const match = sql.match(/^\s*INSERT\s+OR\s+IGNORE\s+INTO\s+([\s\S]+)$/iu);
  if (!match) {
    return sql;
  }
  return `INSERT INTO ${match[1]} ON CONFLICT DO NOTHING`;
}

function replaceQuestionParams(sql: string) {
  let index = 0;
  return sql.replace(/\?/gu, () => {
    index += 1;
    return `$${index}`;
  });
}

export function translateSqliteToPostgresSql(sql: string) {
  let next = sql.trim();
  next = next.replace(/^\s*PRAGMA\s+foreign_keys\s*=\s*ON\s*;?\s*$/gimu, "");
  next = replaceInsertIgnore(next);
  next = next.replace(/CREATE\s+VIEW\s+IF\s+NOT\s+EXISTS/giu, "CREATE OR REPLACE VIEW");
  next = next.replace(/\bMIN\s*\(\s*3\s*,/gu, "LEAST(3,");
  next = replaceJsonHelpers(next);
  next = next.replace(/\bINTEGER\s+PRIMARY\s+KEY\s+AUTOINCREMENT\b/gu, "BIGSERIAL PRIMARY KEY");
  next = replaceQuestionParams(next);
  return next;
}

export function translateD1SchemaToPostgresSql(sql = D1_SCHEMA_SQL) {
  return splitMigrationStatements(sql)
    .map((statement) => translateSqliteToPostgresSql(statement))
    .filter((statement) => statement.trim().length > 0)
    .join("\n\n");
}

export function createPostgresDb(options: CreatePostgresDbOptions = {}): DbClient {
  const pool = new Pool({
    connectionString: options.connectionString ?? process.env.DATABASE_URL,
    ...options.poolConfig,
  });

  return {
    async query<T = Record<string, unknown>>(sql: string, params: unknown[] = []) {
      const translated = translateSqliteToPostgresSql(sql);
      const result = await pool.query<T>(translated, params);
      return {
        rows: result.rows,
      };
    },
    async end() {
      await pool.end();
    },
  };
}

export async function runPostgresMigrations(options: CreatePostgresDbOptions = {}) {
  const db = createPostgresDb(options);
  try {
    for (const statement of splitMigrationStatements(translateD1SchemaToPostgresSql())) {
      await db.query(statement);
    }
  } finally {
    await db.end();
  }
}
