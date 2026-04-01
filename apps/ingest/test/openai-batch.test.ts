import test from "node:test";
import assert from "node:assert/strict";

import {
  buildOpenAIEmbeddingBatchRequest,
  estimateEmbeddingCostUsd,
  estimateEmbeddingInputTokensForText,
} from "../src/openai-batch";

test("buildOpenAIEmbeddingBatchRequest creates an embeddings batch request line", () => {
  const request = buildOpenAIEmbeddingBatchRequest(
    "gutenberg:18:0",
    "Example chunk",
    "text-embedding-3-small",
    768,
  );
  assert.deepEqual(request, {
    custom_id: "gutenberg:18:0",
    method: "POST",
    url: "/v1/embeddings",
    body: {
      model: "text-embedding-3-small",
      input: "Example chunk",
      dimensions: 768,
      encoding_format: "float",
    },
  });
});

test("openai batch token estimation follows the chars-over-four heuristic", () => {
  assert.equal(estimateEmbeddingInputTokensForText(""), 0);
  assert.equal(estimateEmbeddingInputTokensForText("abcd"), 1);
  assert.equal(estimateEmbeddingInputTokensForText("abcde"), 2);
  assert.equal(estimateEmbeddingInputTokensForText("a   b"), 1);
});

test("openai batch cost estimation converts token counts into usd", () => {
  assert.equal(estimateEmbeddingCostUsd(30_000_000_000, 0.01), 300);
});
