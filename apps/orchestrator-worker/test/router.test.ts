import assert from "node:assert/strict";
import test from "node:test";

import { OpenAIRouter } from "../src/router";

test("OpenAIRouter sends a concrete output contract instead of prose placeholders", async () => {
  let requestBody: Record<string, unknown> | null = null;
  const router = new OpenAIRouter(
    "test-key",
    "test-model",
    async (_input, init) => {
      requestBody = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
      return new Response(JSON.stringify({
        choices: [{
          message: {
            content: JSON.stringify({
              type: "direct_response",
              answer: "Tell me more about the kind of grief example you want.",
            }),
          },
        }],
      }), {
        status: 200,
        headers: {
          "content-type": "application/json",
        },
      });
    },
  );

  await router.decide({
    userMessage: "How do people deal with grief?",
    conversationHistory: [],
  });

  assert.ok(requestBody);
  const body = requestBody as { messages?: Array<{ role: string; content: string }> };
  const messages = body.messages;
  const routerPrompt = JSON.parse(String(messages?.[1]?.content ?? "{}")) as {
    outputContract?: {
      allowedTypes?: string[];
      rules?: string[];
    };
  };

  assert.deepEqual(routerPrompt.outputContract?.allowedTypes, ["direct_response", "search", "design_experiment"]);
  assert.ok(routerPrompt.outputContract?.rules?.some((rule) => rule.includes("Only include fields that belong to the chosen type.")));
  assert.match(String(messages?.[0]?.content ?? ""), /Project Gutenberg-derived library of public-domain books/);
  assert.match(String(messages?.[0]?.content ?? ""), /do not answer from broad world knowledge/i);
});

test("OpenAIRouter rejects malformed router JSON instead of silently coercing it", async () => {
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

  await assert.rejects(
    router.decide({
      userMessage: "How do people deal with grief?",
      conversationHistory: [],
    }),
    /Invalid option/,
  );
});
