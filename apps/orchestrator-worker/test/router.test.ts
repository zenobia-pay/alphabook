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

test("OpenAIRouter logs raw request and response bodies to the router audit log", async () => {
  const auditEvents: Array<{ event: string; payload: Record<string, unknown> }> = [];
  const router = new OpenAIRouter(
    "test-key",
    "test-model",
    async () => new Response(JSON.stringify({
      choices: [{
        message: {
          content: JSON.stringify({
            type: "direct_response",
            answer: "I can search the corpus for personal diaries if you want.",
          }),
        },
      }],
      usage: {
        total_tokens: 42,
      },
      id: "resp_123",
    }), {
      status: 200,
      headers: {
        "content-type": "application/json",
      },
    }),
  );

  await router.decide({
    userMessage: "Search for personal diaries.",
    conversationHistory: [],
    auditLog: (event, payload) => {
      auditEvents.push({ event, payload });
    },
  });

  assert.equal(auditEvents[0]?.event, "router.openai.request");
  assert.equal(auditEvents[1]?.event, "router.openai.response");
  assert.equal(auditEvents[1]?.payload.ok, true);
  assert.equal((auditEvents[0]?.payload.request as { model?: string })?.model, "test-model");
});

test("OpenAIRouter sanitizes malformed search decisions instead of failing the run", async () => {
  const router = new OpenAIRouter(
    "test-key",
    "test-model",
    async () => new Response(JSON.stringify({
      choices: [{
        message: {
          content: JSON.stringify({
            type: "search",
            fullQuery: "Find interesting personal diaries and journals in the corpus.",
            executionMode: "auto",
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
    userMessage: "Search for personal diaries.",
    conversationHistory: [],
  });

  assert.deepEqual(decision, {
    type: "search",
    fullQuery: "Find interesting personal diaries and journals in the corpus.",
    executionMode: "agentic",
  });
});

test("OpenAIRouter repairs embedded plain-text experiment plans into structured proposal metadata", async () => {
  let requestCount = 0;
  const router = new OpenAIRouter(
    "test-key",
    "test-model",
    async (_input, init) => {
      requestCount += 1;
      if (requestCount === 1) {
        return new Response(JSON.stringify({
          choices: [{
            message: {
              content: JSON.stringify({
                type: "direct_response",
                answer: [
                  "I can help you plan this experiment.",
                  "",
                  "**experimentProposal.plan**",
                  "- **title:** Humour comparison experiment",
                  "- **researchQuestion:** How do the humour books differ by country?",
                  "- **summary:** Build a passage dataset, label it, and compare the distributions.",
                  "- **dataset:**",
                  "  - **itemUnit:** One sampled passage.",
                  "  - **corpusScope:** Five humour books.",
                  "  - **passageSelection:** Sample evenly across each book.",
                  "  - **expectedItemCount:** 150",
                  "- **labeling:**",
                  "  - **itemCount:** 150",
                  "  - **structuredFields:** humor_target, humor_device",
                  "  - **labelingMethod:** Label each sampled passage.",
                  "  - **costEstimate:** About 150 labels.",
                  "- **resultsView:**",
                  "  - **primaryArtifact:** Comparison report.",
                  "  - **chartType:** grouped bar chart",
                  "  - **xAxis:** country",
                  "  - **yAxis:** labeled passage count",
                  "  - **outputs:** chart image, label table",
                ].join("\n"),
              }),
            },
          }],
        }), {
          status: 200,
          headers: {
            "content-type": "application/json",
          },
        });
      }
      const repairBody = JSON.parse(String(init?.body ?? "{}")) as {
        messages?: Array<{ content?: string }>;
      };
      assert.match(String(repairBody.messages?.[0]?.content ?? ""), /Extract a structured AlphaBook experiment proposal/);
      return new Response(JSON.stringify({
        choices: [{
          message: {
            content: JSON.stringify({
              experimentProposal: {
                plan: {
                  title: "Humour comparison experiment",
                  researchQuestion: "How do the humour books differ by country?",
                  summary: "Build a passage dataset, label it, and compare the distributions.",
                  dataset: {
                    itemUnit: "One sampled passage.",
                    corpusScope: "Five humour books.",
                    passageSelection: "Sample evenly across each book.",
                    expectedItemCount: 150,
                  },
                  labeling: {
                    itemCount: 150,
                    structuredFields: [
                      {
                        name: "humor_target",
                        description: "The main target of the humor.",
                        valueType: "enum",
                        allowedValues: ["self", "other"],
                      },
                    ],
                    labelingMethod: "Label each sampled passage.",
                    costEstimate: "About 150 labels.",
                  },
                  resultsView: {
                    primaryArtifact: "Comparison report.",
                    chartType: "grouped bar chart",
                    xAxis: "country",
                    yAxis: "labeled passage count",
                    outputs: ["chart image", "label table"],
                  },
                },
              },
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

  const decision = await router.decide({
    userMessage: "Help me plan an experiment comparing these humour books by country.",
    conversationHistory: [],
  });

  assert.equal(decision.type, "direct_response");
  assert.equal(decision.workflowHint, "design_experiment");
  assert.equal(decision.experimentProposal?.plan.title, "Humour comparison experiment");
  assert.equal(requestCount, 2);
});

test("OpenAIRouter falls back to a safe search when the router returns a usable query without a valid type", async () => {
  const router = new OpenAIRouter(
    "test-key",
    "test-model",
    async () => new Response(JSON.stringify({
      choices: [{
        message: {
          content: JSON.stringify({
            fullQuery: "Find personal diaries by notable authors in the corpus.",
            executionMode: "invalid",
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
    userMessage: "Personal diaries",
    requestedWorkflow: "search",
    conversationHistory: [],
  });

  assert.deepEqual(decision, {
    type: "search",
    fullQuery: "Find personal diaries by notable authors in the corpus.",
    executionMode: "agentic",
    rationale: "Router response was malformed, but it included a search query so the request can continue safely.",
  });
});

test("OpenAIRouter preserves an explicit agentic request even when the router returns semantic mode", async () => {
  const auditEvents: Array<{ event: string; payload: Record<string, unknown> }> = [];
  const router = new OpenAIRouter(
    "test-key",
    "test-model",
    async () => new Response(JSON.stringify({
      choices: [{
        message: {
          content: JSON.stringify({
            type: "search",
            fullQuery: "Search the corpus for personal diaries and journals.",
            executionMode: "semantic",
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
    userMessage: "search for personal diaries and use agentic search",
    conversationHistory: [],
    auditLog: (event, payload) => {
      auditEvents.push({ event, payload });
    },
  });

  assert.deepEqual(decision, {
    type: "search",
    fullQuery: "Search the corpus for personal diaries and journals.",
    executionMode: "agentic",
  });
  assert.equal(auditEvents.at(-1)?.event, "router.output.override");
});
