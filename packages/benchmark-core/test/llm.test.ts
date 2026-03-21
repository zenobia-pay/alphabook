import assert from "node:assert/strict";
import test from "node:test";

import { createOpenAICompatibleExhaustiveJudge } from "../src/llm";

test("openai-compatible exhaustive judge supports score-only output", async () => {
  let requestBody = "";
  const judge = createOpenAICompatibleExhaustiveJudge({
    apiKey: "test-key",
    model: "test-model",
    includeRationale: false,
    fetchImpl: async (_input, init) => {
      requestBody = String(init?.body ?? "");
      return new Response(JSON.stringify({
        choices: [{
          message: {
            content: JSON.stringify({
              scores: [{ passageId: "p-1", score: 0.9 }],
            }),
          },
        }],
      }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    },
  });

  const scores = await judge.judgeBatch({
    query: {
      id: "q-1",
      text: "dealing with grief",
      family: "associative",
      labels: [],
    },
    passages: [{
      id: "p-1",
      documentId: "d-1",
      chunkIndex: 0,
      text: "A passage about grief and mourning.",
      excerpt: "A passage about grief and mourning.",
    }],
  });

  assert.match(requestBody, /Each score item must contain: passageId and score/u);
  assert.equal(scores[0]?.passageId, "p-1");
  assert.equal(scores[0]?.score, 0.9);
});
