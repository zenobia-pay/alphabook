import postgres from "postgres";

import { MIGRATIONS } from "./sql";
export * from "./d1";
export * from "./d1-sql";

export interface DbClient {
  query<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<{ rows: T[] }>;
  end(): Promise<void>;
}

type PoolLike = {
  query<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<{ rows: T[] }>;
  end(timeout?: number): Promise<void>;
};

type CreatePostgresDbOptions = {
  poolFactory?: (connectionString: string) => PoolLike;
  maxAttempts?: number;
};

const TRANSIENT_DB_ERROR_PATTERNS = [
  /unable to enqueue/i,
  /connection terminated/i,
  /connection ended/i,
  /socket closed/i,
  /fetch failed/i,
  /websocket is not open/i,
  /econnreset/i,
  /epipe/i,
];

function createPool(connectionString: string): PoolLike {
  const sql = postgres(connectionString, {
    idle_timeout: 20,
    max_lifetime: 60 * 30,
  });

  return {
    async query<T>(text: string, params?: unknown[]) {
      const rows = await sql.unsafe(text, (params ?? []) as never[]) as unknown as T[];
      return { rows };
    },
    async end(timeout = 5) {
      await sql.end({ timeout });
    },
  };
}

function isTransientDbError(error: unknown) {
  const message = error instanceof Error ? error.message : String(error ?? "");
  return TRANSIENT_DB_ERROR_PATTERNS.some((pattern) => pattern.test(message));
}

export function createPostgresDb(connectionString: string, options: CreatePostgresDbOptions = {}): DbClient {
  const maxAttempts = Math.max(1, options.maxAttempts ?? 2);
  const poolFactory = options.poolFactory ?? createPool;
  let pool = poolFactory(connectionString);

  return {
    async query<T>(sql: string, params?: unknown[]) {
      let lastError: unknown = null;

      for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
        try {
          const result = await pool.query(sql, params as never[] | undefined);
          return { rows: result.rows as T[] };
        } catch (error) {
          lastError = error;
          if (attempt >= maxAttempts || !isTransientDbError(error)) {
            throw error;
          }

          const previousPool = pool;
          pool = poolFactory(connectionString);
          await previousPool.end().catch(() => {});
        }
      }

      throw lastError instanceof Error ? lastError : new Error("Database query failed.");
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
