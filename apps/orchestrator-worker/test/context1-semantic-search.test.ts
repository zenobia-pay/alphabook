import test from "node:test";
import assert from "node:assert/strict";

import { Context1SemanticSearchService } from "../src/semantic-search";

test("Context1SemanticSearchService searches, prunes, and returns retained chunks", async () => {
  const chunks = [
    {
      id: "chunk-1",
      workId: "work-1",
      chunkIndex: 0,
      text: "Grief appeared in the first chapter as a private wound.",
      excerpt: "Grief appeared in the first chapter as a private wound.",
      r2Key: "books/work-1/chunks.jsonl",
      score: 0.8,
      readerPath: "/works/work-1",
    },
    {
      id: "chunk-2",
      workId: "work-2",
      chunkIndex: 3,
      text: "Mourning became a public ritual in the second book.",
      excerpt: "Mourning became a public ritual in the second book.",
      r2Key: "books/work-2/chunks.jsonl",
      score: 0.7,
      readerPath: "/works/work-2",
    },
  ];
  const actions = [
    { type: "search_corpus", query: "grief and mourning" },
    { type: "prune_chunks", chunkIds: ["chunk-2"] },
    { type: "final", selectedChunkIds: ["chunk-1"] },
  ];
  let actionIndex = 0;
  const service = new Context1SemanticSearchService({
    store: {
      async getRelevantChunks() {
        return chunks;
      },
      async getChunksByIds(ids: string[]) {
        return chunks.filter((chunk: { id: string }) => ids.includes(chunk.id));
      },
      async getChunkByWorkAndIndex() {
        return null;
      },
      async searchWorks() {
        return [];
      },
      async getWorkMetadata() {
        return [];
      },
    } as any,
    embedder: {
      async embedQuery() {
        return [0.1, 0.2, 0.3];
      },
    } as any,
    vectorIndex: {
      async query() {
        return [
          { id: "chunk-1", score: 0.9 },
          { id: "chunk-2", score: 0.85 },
        ];
      },
      async upsert() {},
    },
    apiKey: "test-key",
    model: "context-1-test",
    fetchImpl: async () =>
      new Response(
        JSON.stringify({
          choices: [
            {
              message: {
                content: JSON.stringify(actions[actionIndex++]),
              },
            },
          ],
        }),
        {
          status: 200,
          headers: {
            "content-type": "application/json",
          },
        },
      ),
    maxTurns: 4,
    totalTokenBudget: 2000,
    softTokenBudget: 1000,
    hardTokenBudget: 1600,
    perToolTokenBudget: 1000,
  });

  const result = await service.search({
    query: "Trace grief across the corpus",
    maxResults: 4,
  });

  assert.equal(result.chunks.length, 1);
  assert.equal(result.chunks[0]?.id, "chunk-1");
  assert.equal(result.totalChunksConsidered, 2);
  assert.equal(result.iterations.length, 1);
  assert.match(result.briefing, /Context-1 mode searched iteratively/i);
});
