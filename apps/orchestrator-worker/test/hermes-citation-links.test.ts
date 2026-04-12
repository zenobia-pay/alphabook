import test from "node:test";
import assert from "node:assert/strict";

import { createApp } from "../src/app";
import { createBillingService } from "../src/billing";
import { HashEmbedder } from "../src/embeddings";
import { MemoryBlobStore } from "../src/r2";
import { InMemoryAppStore } from "../src/store";

test("Hermes final answers rewrite local hit links into reader links before storing the assistant message", async () => {
  const originalFetch = globalThis.fetch;
  const now = new Date().toISOString();

  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    const method = init?.method ?? "GET";
    if (url === "https://hermes.example.test/v1/jobs" && method === "POST") {
      return new Response(JSON.stringify({
        job: {
          id: "job-hermes-citation-links",
          state: "completed",
          running: false,
          pid: 4321,
          userPrompt: "Find passages about grief and loss.",
          model: "gpt-5.4",
          maxTurns: 60,
          launchedAt: now,
          startedAt: now,
          finishedAt: now,
          innerRunDir: "/srv/alphabook/logs/corpus-research/example",
          innerRunId: "example",
          hermesSessionId: "hermes-session-1",
          archivePrefix: null,
          exitCode: 0,
          heartbeatAt: now,
          phase: "completed",
          phaseProgressPct: 100,
          detail: "Completed",
          manifestStatus: "completed",
          chosenScope: "Jane Eyre",
          scopeRationale: "The query names the work explicitly.",
          recordCounts: null,
        },
      }), { status: 200, headers: { "content-type": "application/json" } });
    }
    if (url === "https://hermes.example.test/v1/jobs/job-hermes-citation-links" && method === "GET") {
      return new Response(JSON.stringify({
        job: {
          id: "job-hermes-citation-links",
          state: "completed",
          running: false,
          pid: 4321,
          userPrompt: "Find passages about grief and loss.",
          model: "gpt-5.4",
          maxTurns: 60,
          launchedAt: now,
          startedAt: now,
          finishedAt: now,
          innerRunDir: "/srv/alphabook/logs/corpus-research/example",
          innerRunId: "example",
          hermesSessionId: "hermes-session-1",
          archivePrefix: null,
          exitCode: 0,
          heartbeatAt: now,
          phase: "completed",
          phaseProgressPct: 100,
          detail: "Completed",
          manifestStatus: "completed",
          chosenScope: "Jane Eyre",
          scopeRationale: "The query names the work explicitly.",
          recordCounts: null,
        },
      }), { status: 200, headers: { "content-type": "application/json" } });
    }
    if (url.startsWith("https://hermes.example.test/v1/jobs/job-hermes-citation-links/logs") && method === "GET") {
      return new Response(JSON.stringify({
        jobId: "job-hermes-citation-links",
        sources: [],
        nextCursor: "",
      }), { status: 200, headers: { "content-type": "application/json" } });
    }
    if (url === "https://hermes.example.test/v1/jobs/job-hermes-citation-links/artifacts" && method === "GET") {
      return new Response(JSON.stringify({
        jobId: "job-hermes-citation-links",
        runDir: "/srv/alphabook/logs/corpus-research/example",
        innerRunDir: "/srv/alphabook/logs/corpus-research/example/inner",
        artifacts: [
          { name: "briefing.md", path: "/tmp/briefing.md", bytes: 32, updatedAt: now },
          { name: "hits/index.json", path: "/tmp/hits-index.json", bytes: 240, updatedAt: now },
          { name: "final-answer.md", path: "/tmp/final-answer.md", bytes: 220, updatedAt: now },
          { name: "final-answer.json", path: "/tmp/final-answer.json", bytes: 220, updatedAt: now },
          { name: "hermes.session.json", path: "/tmp/hermes.session.json", bytes: 80, updatedAt: now },
        ],
      }), { status: 200, headers: { "content-type": "application/json" } });
    }
    if (url.endsWith("/artifacts/briefing.md") && method === "GET") {
      return new Response(JSON.stringify({
        jobId: "job-hermes-citation-links",
        artifact: {
          name: "briefing.md",
          path: "/tmp/briefing.md",
          bytes: 32,
          updatedAt: now,
          content: "# Briefing\n\nFocused scope.",
        },
      }), { status: 200, headers: { "content-type": "application/json" } });
    }
    if (url.endsWith("/artifacts/hits%2Findex.json") && method === "GET") {
      return new Response(JSON.stringify({
        jobId: "job-hermes-citation-links",
        artifact: {
          name: "hits/index.json",
          path: "/tmp/hits-index.json",
          bytes: 240,
          updatedAt: now,
          content: JSON.stringify({
            hit_count: 1,
            hits: [
              {
                hit_id: "hit-0001",
                work_id: "work-jane-eyre",
                source_title: "Jane Eyre",
                chunk_id: "chunk-1",
                reader_path: "/1342/passages/grief-1",
                quote: "I grieved to leave the garden.",
              },
            ],
          }),
        },
      }), { status: 200, headers: { "content-type": "application/json" } });
    }
    if (url.endsWith("/artifacts/final-answer.md") && method === "GET") {
      return new Response(JSON.stringify({
        jobId: "job-hermes-citation-links",
        artifact: {
          name: "final-answer.md",
          path: "/tmp/final-answer.md",
          bytes: 220,
          updatedAt: now,
          content: "Jane Eyre treats grief as intimate and formative. ([hit-0001.md](./hits/hit-0001.md))",
        },
      }), { status: 200, headers: { "content-type": "application/json" } });
    }
    if (url.endsWith("/artifacts/final-answer.json") && method === "GET") {
      return new Response(JSON.stringify({
        jobId: "job-hermes-citation-links",
        artifact: {
          name: "final-answer.json",
          path: "/tmp/final-answer.json",
          bytes: 220,
          updatedAt: now,
          content: JSON.stringify({
            answer: "Jane Eyre treats grief as intimate and formative.",
            citations: [
              {
                hit: "hit-0001",
                title: "Jane Eyre",
                alphabook_url: null,
              },
            ],
          }),
        },
      }), { status: 200, headers: { "content-type": "application/json" } });
    }
    if (url.endsWith("/artifacts/hermes.session.json") && method === "GET") {
      return new Response(JSON.stringify({
        jobId: "job-hermes-citation-links",
        artifact: {
          name: "hermes.session.json",
          path: "/tmp/hermes.session.json",
          bytes: 80,
          updatedAt: now,
          content: JSON.stringify({ session_id: "hermes-session-1", messages: [] }),
        },
      }), { status: 200, headers: { "content-type": "application/json" } });
    }
    throw new Error(`Unexpected fetch: ${method} ${url}`);
  }) as typeof fetch;

  try {
    const store = new InMemoryAppStore([], []);
    const app = createApp({
      store,
      billing: createBillingService(store),
      embedder: new HashEmbedder(),
      blobStore: new MemoryBlobStore(),
      hermesJobApiUrl: "https://hermes.example.test",
      hermesJobApiToken: "test-token",
      queues: {
        ingestName: "alphabook-ingest",
        jobsName: "alphabook-jobs",
      },
      implementation: {
        id: "alphabook",
        productName: "AlphaBook",
        siteOrigin: "https://alpha-book.org",
        apiOrigin: "https://api.alpha-book.org",
        allowedWebOrigins: ["https://alpha-book.org"],
        defaultUserName: "AlphaBook User",
        defaultReaderName: "AlphaBook Reader",
      },
    });

    const registrationResponse = await app.request("/v1/agents/register", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        name: "Codex",
        description: "AlphaBook autonomous researcher",
      }),
    });
    assert.equal(registrationResponse.status, 201);
    const registrationPayload = await registrationResponse.json() as { api_key: string };

    const kickoffResponse = await app.request("/v1/research/runs", {
      method: "POST",
      headers: {
        authorization: `Bearer ${registrationPayload.api_key}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        query: "Find passages about grief and loss in Jane Eyre.",
        intensityOverride: "normal",
      }),
    });
    assert.equal(kickoffResponse.status, 201);
    const kickoffPayload = await kickoffResponse.json() as { runId: string };

    for (let attempt = 0; attempt < 3; attempt += 1) {
      const resultResponse = await app.request(`/v1/research/runs/${kickoffPayload.runId}`, {
        headers: { authorization: `Bearer ${registrationPayload.api_key}` },
      });
      assert.equal(resultResponse.status, 200);
      const resultPayload = await resultResponse.json() as { status: string };
      if (resultPayload.status === "completed") {
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 10));
    }

    const storedRun = await store.getRun(kickoffPayload.runId);
    assert.ok(storedRun);
    const storedMessages = await store.listMessages(storedRun.sessionId);
    const finalAssistant = [...storedMessages].reverse().find((message) => message.role === "assistant" && message.metadata?.phase === "answer");
    assert.ok(finalAssistant);
    assert.match(finalAssistant.content, /\[hit-0001\.md\]\(https:\/\/alpha-book\.org\/\?view=explore&work=work-jane-eyre(?:&session=[^)]+)?&reader=%2F1342%2Fpassages%2Fgrief-1\)/);
    assert.doesNotMatch(finalAssistant.content, /\]\(\.\/hits\/hit-0001\.md\)/);
    assert.doesNotMatch(finalAssistant.content, /\]\(hits\/hit-0001\.md\)/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
