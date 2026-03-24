import assert from "node:assert/strict";
import test from "node:test";

import { estimateSpritePrepareTimeoutMs, spriteGuestConfig } from "../src/runtime";

test("estimateSpritePrepareTimeoutMs scales up for larger shard hydration", () => {
  const small = estimateSpritePrepareTimeoutMs({
    bookCount: 100,
    totalTextBytes: 32 * 1024 * 1024,
  });
  const large = estimateSpritePrepareTimeoutMs({
    bookCount: 1000,
    totalTextBytes: 512 * 1024 * 1024,
  });

  assert.equal(small, 90_000);
  assert.ok(large > small);
  assert.ok(large <= 10 * 60_000);
});

test("spriteGuestConfig gives shard searches stronger machines by default", () => {
  assert.deepEqual(
    spriteGuestConfig("shard", {}),
    {
      cpu_kind: "performance",
      cpus: 4,
      memory_mb: 8192,
    },
  );
  assert.deepEqual(
    spriteGuestConfig("aggregate", {}),
    {
      cpu_kind: "shared",
      cpus: 2,
      memory_mb: 4096,
    },
  );
});

test("spriteGuestConfig preserves larger configured machine sizes", () => {
  assert.deepEqual(
    spriteGuestConfig("shard", {
      machineCpuKind: "performance",
      machineCpus: 8,
      machineMemoryMb: 16_384,
    }),
    {
      cpu_kind: "performance",
      cpus: 8,
      memory_mb: 16_384,
    },
  );
});
