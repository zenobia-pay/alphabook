import assert from "node:assert/strict";
import test from "node:test";

import { createD1Db, splitMigrationStatements } from "../src/index";

test("createD1Db maps D1 all() results onto the shared DbClient interface", async () => {
  const issued: Array<{ sql: string; params: unknown[] }> = [];
  const db = createD1Db({
    prepare(sql: string) {
      return {
        bind(...params: unknown[]) {
          return {
            async all() {
              issued.push({ sql, params });
              return { results: [{ ok: true }] };
            },
            async run() {
              return {};
            },
          };
        },
        async all() {
          issued.push({ sql, params: [] });
          return { results: [{ ok: true }] };
        },
        async run() {
          return {};
        },
      };
    },
    async batch() {
      return [];
    },
  });

  const result = await db.query<{ ok: boolean }>("select 1 where id = ?", ["x"]);
  assert.deepEqual(result.rows, [{ ok: true }]);
  assert.deepEqual(issued, [{ sql: "select 1 where id = ?", params: ["x"] }]);
});

test("splitMigrationStatements breaks D1 migrations into runnable statements", () => {
  const statements = splitMigrationStatements(`
CREATE TABLE a (id integer);
CREATE INDEX idx_a_id ON a(id);
  `);

  assert.deepEqual(statements, [
    "CREATE TABLE a (id integer);",
    "CREATE INDEX idx_a_id ON a(id);",
  ]);
});
