import test from "node:test";
import assert from "node:assert/strict";

import { OpenAIPlanner, type PlannerContext } from "../src/planner";

test("OpenAIPlanner starts with workspace creation before later retrieval steps", async () => {
  const planner = new OpenAIPlanner(
    "test-key",
    "test-model",
    async () =>
      new Response(
        JSON.stringify({
          choices: [
            {
              message: {
                content: JSON.stringify({
                  type: "tool_call",
                  tool_name: "get_relevant_chunks",
                  rationale: "Try another seed pass.",
                  args: {
                    query: "find passages where people who broke up got back together",
                    filters: { limit: 20 },
                  },
                }),
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
  );

  const context: PlannerContext = {
    userMessage: "find passages where people who broke up got back together",
    conversationHistory: [
      {
        role: "user",
        content: "find passages where people who broke up got back together",
      },
    ],
    turns: 4,
    toolHistory: [
      {
        toolName: "search_works",
        args: { query: "find passages where people who broke up got back together" },
        result: { works: [] },
      },
      {
        toolName: "get_relevant_chunks",
        args: { query: "find passages where people who broke up got back together" },
        result: { chunks: [] },
      },
      {
        toolName: "search_works",
        args: { query: "reconciliation after breakup in fiction" },
        result: { works: [] },
      },
    ],
  };

  const decision = await planner.decide(context);

  assert.equal(decision.type, "tool_call");
  assert.equal(decision.tool_name, "create_workspace");
  assert.match(decision.rationale ?? "", /starting the codex workspace/i);
});
