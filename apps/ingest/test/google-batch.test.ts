import test from "node:test";
import assert from "node:assert/strict";

import {
  buildGoogleEmbeddingBatchRequest,
  estimateEmbeddingCostUsd,
  estimateEmbeddingInputTokensForText,
} from "../src/google-batch";

test("buildGoogleEmbeddingBatchRequest creates a retrieval-document embedding request", () => {
  const request = buildGoogleEmbeddingBatchRequest("Example chunk", 768, "Example Title");
  assert.deepEqual(request, {
    request: {
      content: {
        parts: [{ text: "Example chunk" }],
      },
      taskType: "RETRIEVAL_DOCUMENT",
      title: "Example Title",
      outputDimensionality: 768,
    },
  });
});

test("estimateEmbeddingInputTokensForText follows the chars-over-four heuristic", () => {
  assert.equal(estimateEmbeddingInputTokensForText(""), 0);
  assert.equal(estimateEmbeddingInputTokensForText("abcd"), 1);
  assert.equal(estimateEmbeddingInputTokensForText("abcde"), 2);
  assert.equal(estimateEmbeddingInputTokensForText("a   b"), 1);
});

test("estimateEmbeddingCostUsd converts token counts into usd", () => {
  assert.equal(estimateEmbeddingCostUsd(4_000_000_000, 0.075), 300);
});
