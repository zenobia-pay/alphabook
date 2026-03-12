import { Pool, neonConfig } from "@neondatabase/serverless";

import { MIGRATIONS } from "./sql";

export interface DbClient {
  query<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<{ rows: T[] }>;
  end(): Promise<void>;
}

export function createNeonDb(connectionString: string): DbClient {
  neonConfig.fetchConnectionCache = true;
  const pool = new Pool({ connectionString });
  return {
    async query<T>(sql: string, params?: unknown[]) {
      const result = await pool.query(sql, params as never[] | undefined);
      return { rows: result.rows as T[] };
    },
    async end() {
      await pool.end();
    },
  };
}

export async function runMigrations(db: DbClient): Promise<void> {
  for (const migration of MIGRATIONS) {
    await db.query(migration.sql);
  }
}

export const schemaMigrations = MIGRATIONS;
