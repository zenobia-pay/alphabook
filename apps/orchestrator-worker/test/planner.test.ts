import test from "node:test";
import assert from "node:assert/strict";

import { OpenAIPlanner, type PlannerContext } from "../src/planner";

test("OpenAIPlanner sizes the work first once semantic retrieval has already run", async () => {
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
  assert.equal(decision.tool_name, "estimate_research_scope");
  assert.match(decision.rationale ?? "", /sizing the vetted evidence set/i);
});

test("OpenAIPlanner does not force create_workspace again while it is pending", async () => {
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
                  tool_name: "search_works",
                  rationale: "Keep retrieval moving while the workspace starts.",
                  args: {
                    query: "find revealing passages about grief and mourning",
                    filters: { limit: 12 },
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
    userMessage: "find revealing passages about grief and mourning",
    conversationHistory: [
      {
        role: "user",
        content: "find revealing passages about grief and mourning",
      },
    ],
    turns: 2,
    toolHistory: [],
    pendingTools: [
      {
        toolName: "create_workspace",
        args: {
          workIds: [],
          chunkIds: [],
          taskContext: {
            question: "find revealing passages about grief and mourning",
          },
        },
      },
    ],
  };

  const decision = await planner.decide(context);

  assert.equal(decision.type, "tool_call");
  assert.equal(decision.tool_name, "search_works");
  assert.match(decision.rationale ?? "", /surfacing likely books immediately/i);
});

test("OpenAIPlanner routes semantic mode straight to semantic_deep_search", async () => {
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
                  tool_name: "search_works",
                  rationale: "ignored",
                  args: {
                    query: "ignored",
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

  const decision = await planner.decide({
    mode: "semantic",
    userMessage: "find passages where mourning becomes consolation",
    conversationHistory: [
      {
        role: "user",
        content: "find passages where mourning becomes consolation",
      },
    ],
    turns: 1,
    toolHistory: [],
  });

  assert.equal(decision.type, "tool_call");
  assert.equal(decision.tool_name, "semantic_deep_search");
});
