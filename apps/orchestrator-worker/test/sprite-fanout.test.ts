import test from "node:test";
import assert from "node:assert/strict";

import { isSpriteShardCatalogUsable, type SpriteShardCatalog } from "../src/sprite-fanout";

test("sprite shard catalogs are rejected when the live corpus count has changed", () => {
  const staleCatalog: SpriteShardCatalog = {
    implementationId: "alphabook",
    generatedAt: "2026-03-27T11:00:12.315Z",
    shardSize: 1000,
    shardCount: 1,
    shards: [
      {
        implementationId: "alphabook",
        shardId: "books-1",
        index: 0,
        totalShards: 1,
        bookCount: 29,
        workIds: Array.from({ length: 29 }, (_, index) => `work-${index + 1}`),
        totalTextBytes: 0,
      },
    ],
  };

  assert.equal(isSpriteShardCatalogUsable(staleCatalog, 85), false);
  assert.equal(isSpriteShardCatalogUsable(staleCatalog, 29), true);
});
