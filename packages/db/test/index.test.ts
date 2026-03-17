import assert from "node:assert/strict";
import test from "node:test";

import { createNeonDb } from "../src/index";

test("createNeonDb retries transient Neon transport errors with a fresh pool", async () => {
  const calls: string[] = [];
  let poolCount = 0;
  const pools = [
    {
      async query() {
        calls.push("pool-1.query");
        throw new Error("Unable to enqueue");
      },
      async end() {
        calls.push("pool-1.end");
      },
    },
    {
      async query() {
        calls.push("pool-2.query");
        return { rows: [{ ok: true }] };
      },
      async end() {
        calls.push("pool-2.end");
      },
    },
  ];

  const db = createNeonDb("postgres://example", {
    poolFactory: () => pools[poolCount++]!,
  });

  const result = await db.query<{ ok: boolean }>("select 1");
  assert.deepEqual(result.rows, [{ ok: true }]);
  assert.deepEqual(calls, ["pool-1.query", "pool-1.end", "pool-2.query"]);
});

test("createNeonDb does not retry non-transient errors", async () => {
  const calls: string[] = [];
  const db = createNeonDb("postgres://example", {
    poolFactory: () => ({
      async query() {
        calls.push("query");
        throw new Error("column does not exist");
      },
      async end() {
        calls.push("end");
      },
    }),
  });

  await assert.rejects(() => db.query("select nope"), /column does not exist/);
  assert.deepEqual(calls, ["query"]);
});
