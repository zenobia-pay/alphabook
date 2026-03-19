import test from "node:test";
import assert from "node:assert/strict";

import type { Citation } from "@alphabook/shared";

import { FallbackSynthesizer, OpenAISynthesizer, type ToolHistoryEntry } from "../src/synthesizer";

const hypothesisToolHistory: ToolHistoryEntry[] = [
  {
    toolName: "run_workspace_task",
    args: {},
    result: {
      briefing: "Supporting evidence points one way, but there are also counterexamples that complicate the claim.",
      citations: [
        {
          workId: "work-a",
          chunkId: "chunk-a",
          label: "work-a#1",
          excerpt: "supporting evidence",
        },
        {
          workId: "work-b",
          chunkId: "chunk-b",
          label: "work-b#2",
          excerpt: "opposing evidence",
        },
      ] satisfies Citation[],
    },
  },
];

test("FallbackSynthesizer uses a verdict-style opening and mode-aware CTA for hypothesis prompts", async () => {
  const synthesizer = new FallbackSynthesizer();
  const result = await synthesizer.synthesize({
    userMessage: "Test the claim that 19th century fiction treats grief as mainly religious consolation.",
    conversationHistory: [],
    plannerCitations: [],
    toolHistory: hypothesisToolHistory,
    runtimeBriefing: null,
    runtimeEvidenceNotes: null,
    researchDocument: null,
  });

  assert.match(result.answer, /searched the corpus for evidence on both sides/i);
  assert.match(result.answer, /Next steps: I can widen the for\/against evidence/i);
});

test("FallbackSynthesizer preserves broader citation breadth for comparison-style prompts", async () => {
  const synthesizer = new FallbackSynthesizer();
  const result = await synthesizer.synthesize({
    userMessage: "Compare how three novels handle grief.",
    conversationHistory: [],
    plannerCitations: [
      { workId: "work-a", chunkId: "chunk-a", label: "work-a#1", excerpt: "a" },
      { workId: "work-b", chunkId: "chunk-b", label: "work-b#2", excerpt: "b" },
      { workId: "work-c", chunkId: "chunk-c", label: "work-c#3", excerpt: "c" },
    ],
    toolHistory: [],
    runtimeBriefing: "The comparison shows one novel turning inward, one toward ritual, and one toward duty.",
    runtimeEvidenceNotes: null,
    researchDocument: null,
  });

  assert.equal(new Set(result.citations.map((citation) => citation.workId)).size, 3);
});

test("OpenAISynthesizer sends prompt-type-specific structure instructions", async () => {
  let capturedBody: Record<string, unknown> | null = null;
  const synthesizer = new OpenAISynthesizer(
    "test-key",
    "test-model",
    async (_input, init) => {
      capturedBody = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
      return new Response(JSON.stringify({
        choices: [
          {
            message: {
              content: JSON.stringify({
                answer: "Verdict: the evidence is mixed but leans supportive.",
                citations: [],
              }),
            },
          },
        ],
      }), { status: 200, headers: { "content-type": "application/json" } });
    },
  );

  await synthesizer.synthesize({
    userMessage: "Test the claim that grief in these novels leads mainly to withdrawal.",
    conversationHistory: [],
    plannerCitations: [],
    toolHistory: [],
    runtimeBriefing: null,
    runtimeEvidenceNotes: null,
    researchDocument: null,
  });

  assert.ok(capturedBody);
  const rawMessages = capturedBody && Array.isArray((capturedBody as { messages?: unknown }).messages)
    ? (capturedBody as { messages: Array<Record<string, unknown>> }).messages
    : [];
  const messages = rawMessages;
  const userMessage = messages.find((message) => message.role === "user");
  assert.ok(userMessage && typeof userMessage.content === "string");
  const parsed = JSON.parse(userMessage.content);
  assert.equal(parsed.synthesisMode, "hypothesis");
  assert.ok(Array.isArray(parsed.responseStructure));
  assert.match(parsed.responseStructure.join(" "), /verdict/i);
});

test("FallbackSynthesizer marks what changed for follow-up prompts", async () => {
  const synthesizer = new FallbackSynthesizer();
  const result = await synthesizer.synthesize({
    userMessage: "Follow up on that and narrow to religious consolation.",
    conversationHistory: [
      { role: "assistant", content: "Earlier answer summary about grief across several books." },
    ],
    plannerCitations: [],
    toolHistory: [
      {
        toolName: "run_workspace_task",
        args: {},
        result: {
          briefing: "Several passages narrow the pattern toward explicitly religious consolation.",
          citations: [],
        },
      },
    ],
    runtimeBriefing: null,
    runtimeEvidenceNotes: null,
    researchDocument: null,
  });

  assert.match(result.answer, /follow-up refines the earlier answer|follow-up adds narrower evidence/i);
});

test("OpenAISynthesizer answer evaluation includes claim coverage and format fit", async () => {
  let capturedBody: Record<string, unknown> | null = null;
  const synthesizer = new OpenAISynthesizer(
    "test-key",
    "test-model",
    async (_input, init) => {
      capturedBody = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
      return new Response(JSON.stringify({
        choices: [
          {
            message: {
              content: JSON.stringify({
                usefulness: 8,
                uniqueness: 7,
                supportForQuestion: 8,
                claimCoverage: 7,
                formatFit: 9,
                openQuestionsCount: 1,
                rationale: "Grounded and well-shaped for the prompt type.",
              }),
            },
          },
        ],
      }), { status: 200, headers: { "content-type": "application/json" } });
    },
  );

  const evaluation = await synthesizer.evaluateAnswer?.({
    userMessage: "Compare these books.",
    answer: "The main contrast is between ritual grief and private withdrawal.",
    citations: [],
    priorAnswerSummary: "Earlier answer summary.",
  });

  assert.ok(evaluation);
  assert.equal(evaluation?.claimCoverage, 7);
  assert.equal(evaluation?.formatFit, 9);
  assert.ok(capturedBody);
  const messages = Array.isArray((capturedBody as { messages?: unknown }).messages)
    ? (capturedBody as { messages: Array<Record<string, unknown>> }).messages
    : [];
  const userMessage = messages.find((message) => message.role === "user");
  assert.ok(userMessage && typeof userMessage.content === "string");
  const parsed = JSON.parse(userMessage.content);
  assert.equal(parsed.synthesisMode, "comparison");
  assert.ok(parsed.rubric.claimCoverage);
  assert.ok(parsed.rubric.formatFit);
});
