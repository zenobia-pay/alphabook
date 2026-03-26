import assert from "node:assert/strict";
import test from "node:test";

import { estimateSpritePrepareTimeoutMs, isStaleSpriteMachine, spriteGuestConfig } from "../src/runtime";

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

test("isStaleSpriteMachine ignores current-session shard machines", () => {
  assert.equal(
    isStaleSpriteMachine(
      {
        id: "machine-1",
        name: "alphabook-sprite-a6381ba1-deadbeef",
        updated_at: "2026-03-24T19:00:00.000Z",
        incomplete_config: {
          metadata: {
            "alphabook.runtime_mode": "sprite-shard",
            "alphabook.session_id": "a6381ba1-130b-493a-95c1-90722b343b4b",
          },
        },
      },
      "a6381ba1-130b-493a-95c1-90722b343b4b",
      Date.parse("2026-03-24T20:00:00.000Z"),
    ),
    false,
  );
});

test("isStaleSpriteMachine matches old shard machines from other sessions", () => {
  assert.equal(
    isStaleSpriteMachine(
      {
        id: "machine-2",
        name: "alphabook-sprite-f9719734-deadbeef",
        updated_at: "2026-03-24T19:00:00.000Z",
        incomplete_config: {
          metadata: {
            "alphabook.runtime_mode": "sprite-shard",
            "alphabook.session_id": "f9719734-274f-412f-838f-1e7d7549136e",
          },
        },
      },
      "a6381ba1-130b-493a-95c1-90722b343b4b",
      Date.parse("2026-03-24T20:00:00.000Z"),
    ),
    true,
  );
});
