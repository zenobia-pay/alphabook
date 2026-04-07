import test from "node:test";
import assert from "node:assert/strict";

import { OpenAIRouter } from "../src/router";

test("OpenAIRouter tolerates malformed workflowHint on direct responses", async () => {
  const router = new OpenAIRouter(
    "test-key",
    "test-model",
    async () => new Response(JSON.stringify({
      choices: [{
        message: {
          content: JSON.stringify({
            type: "direct_response",
            answer: "People deal with grief in many different ways.",
            workflowHint: "optional search | design_experiment hint when using direct_response",
          }),
        },
      }],
    }), {
      status: 200,
      headers: {
        "content-type": "application/json",
      },
    }),
  );

  const decision = await router.decide({
    userMessage: "How do people deal with grief?",
    conversationHistory: [],
  });

  assert.equal(decision.type, "direct_response");
  assert.equal(decision.answer, "People deal with grief in many different ways.");
  assert.equal(decision.workflowHint, "design_experiment");
});

test("OpenAIRouter falls back instead of throwing on malformed JSON shapes", async () => {
  const router = new OpenAIRouter(
    "test-key",
    "test-model",
    async () => new Response(JSON.stringify({
      choices: [{
        message: {
          content: JSON.stringify({
            type: "direct_response",
            workflowHint: 123,
          }),
        },
      }],
    }), {
      status: 200,
      headers: {
        "content-type": "application/json",
      },
    }),
  );

  const decision = await router.decide({
    userMessage: "How do people deal with grief?",
    conversationHistory: [],
  });

  assert.equal(decision.type, "direct_response");
  assert.match(decision.answer, /many different ways|search the corpus|respond directly/i);
});
