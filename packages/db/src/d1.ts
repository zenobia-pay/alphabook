import type { DbClient } from "./index";

export interface D1BindingLike {
  prepare(query: string): {
    bind(...values: unknown[]): {
      all<T = Record<string, unknown>>(): Promise<{ results?: T[] }>;
      run(): Promise<unknown>;
    };
    all<T = Record<string, unknown>>(): Promise<{ results?: T[] }>;
    run(): Promise<unknown>;
  };
  batch(statements: unknown[]): Promise<unknown[]>;
}

function splitMigrationStatements(sql: string): string[] {
  return sql
    .split(/;\s*\n/gu)
    .map((statement) => statement.trim())
    .filter((statement) => statement.length > 0)
    .map((statement) => (statement.endsWith(";") ? statement : `${statement};`));
}

export function createD1Db(binding: D1BindingLike): DbClient {
  return {
    async query<T = Record<string, unknown>>(sql: string, params: unknown[] = []) {
      const prepared = binding.prepare(sql);
      const runner = params.length > 0 ? prepared.bind(...params) : prepared;
      const result = await runner.all<T>();
      return {
        rows: Array.isArray(result.results) ? result.results : [],
      };
    },
    async end() {
      return Promise.resolve();
    },
  };
}

export async function runD1Migrations(binding: D1BindingLike, migrations: Array<{ sql: string }>) {
  const statements = migrations.flatMap((migration) => splitMigrationStatements(migration.sql));
  for (const statement of statements) {
    await binding.prepare(statement).run();
  }
}

export { splitMigrationStatements };
