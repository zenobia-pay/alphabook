import test from "node:test";
import assert from "node:assert/strict";

import { QdrantVectorIndex } from "../src/vectorize";

test("QdrantVectorIndex maps search results into vector search matches", async () => {
  let requestUrl = "";
  let requestBody = "";
  const index = new QdrantVectorIndex(
    "https://qdrant.example.com",
    "alphabook-semantic",
    "secret",
    10_000,
    async (input, init) => {
      requestUrl = String(input);
      requestBody = String(init?.body ?? "");
      return Response.json({
        result: [
          {
            id: "8c1b6f3b-a2f7-5b45-b8ca-9f22fe5a6fc5",
            score: 0.91,
            payload: {
              source_id: "chunk-1",
              work_id: "work-1",
            },
          },
        ],
      });
    },
  );

  const matches = await index.query([0.1, 0.2], {
    topK: 5,
    filter: {
      work_id: "work-1",
    },
    returnMetadata: true,
  });

  assert.equal(requestUrl, "https://qdrant.example.com/collections/alphabook-semantic/points/search");
  assert.match(requestBody, /"limit":5/);
  assert.match(requestBody, /"with_payload":true/);
  assert.match(requestBody, /"key":"work_id"/);
  assert.equal(matches[0]?.id, "chunk-1");
  assert.equal(matches[0]?.score, 0.91);
  assert.deepEqual(matches[0]?.metadata, { work_id: "work-1" });
});

test("QdrantVectorIndex writes vectors using Qdrant point upserts", async () => {
  let requestUrl = "";
  let requestBody = "";
  const index = new QdrantVectorIndex(
    "https://qdrant.example.com",
    "alphabook-semantic",
    undefined,
    10_000,
    async (input, init) => {
      requestUrl = String(input);
      requestBody = String(init?.body ?? "");
      return Response.json({
        result: {
          status: "acknowledged",
        },
      });
    },
  );

  await index.upsert([{
    id: "chunk-2",
    values: [0.2, 0.3],
    metadata: {
      work_id: "work-2",
      chunk_index: 3,
    },
  }]);

  assert.equal(requestUrl, "https://qdrant.example.com/collections/alphabook-semantic/points?wait=true");
  assert.match(requestBody, /"id":"[0-9a-f-]{36}"/);
  assert.match(requestBody, /"vector":\[0.2,0.3\]/);
  assert.match(requestBody, /"source_id":"chunk-2"/);
  assert.match(requestBody, /"work_id":"work-2"/);
});
