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

test("Hermes single-book direct-read citations rewrite clean.txt links into reader passage links", async () => {
  const originalFetch = globalThis.fetch;
  const now = new Date().toISOString();

  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    const method = init?.method ?? "GET";
    if (url === "https://hermes.example.test/v1/jobs" && method === "POST") {
      return new Response(JSON.stringify({
        job: {
          id: "job-hermes-direct-source",
          state: "completed",
          running: false,
          pid: 4321,
          userPrompt: "What can I take from this humor anthology?",
          model: "gpt-5.4",
          maxTurns: 60,
          launchedAt: now,
          startedAt: now,
          finishedAt: now,
          innerRunDir: "/srv/alphabook/logs/corpus-research/direct-source",
          innerRunId: "direct-source",
          hermesSessionId: "hermes-session-2",
          archivePrefix: null,
          exitCode: 0,
          heartbeatAt: now,
          phase: "completed",
          phaseProgressPct: 100,
          detail: "Completed",
          manifestStatus: "completed",
          chosenScope: "The humour of Spain",
          scopeRationale: "The user named one book.",
          recordCounts: null,
        },
      }), { status: 200, headers: { "content-type": "application/json" } });
    }
    if (url === "https://hermes.example.test/v1/jobs/job-hermes-direct-source" && method === "GET") {
      return new Response(JSON.stringify({
        job: {
          id: "job-hermes-direct-source",
          state: "completed",
          running: false,
          pid: 4321,
          userPrompt: "What can I take from this humor anthology?",
          model: "gpt-5.4",
          maxTurns: 60,
          launchedAt: now,
          startedAt: now,
          finishedAt: now,
          innerRunDir: "/srv/alphabook/logs/corpus-research/direct-source",
          innerRunId: "direct-source",
          hermesSessionId: "hermes-session-2",
          archivePrefix: null,
          exitCode: 0,
          heartbeatAt: now,
          phase: "completed",
          phaseProgressPct: 100,
          detail: "Completed",
          manifestStatus: "completed",
          chosenScope: "The humour of Spain",
          scopeRationale: "The user named one book.",
          recordCounts: null,
        },
      }), { status: 200, headers: { "content-type": "application/json" } });
    }
    if (url.startsWith("https://hermes.example.test/v1/jobs/job-hermes-direct-source/logs") && method === "GET") {
      return new Response(JSON.stringify({
        jobId: "job-hermes-direct-source",
        sources: [],
        nextCursor: "",
      }), { status: 200, headers: { "content-type": "application/json" } });
    }
    if (url === "https://hermes.example.test/v1/jobs/job-hermes-direct-source/artifacts" && method === "GET") {
      return new Response(JSON.stringify({
        jobId: "job-hermes-direct-source",
        runDir: "/srv/alphabook/logs/corpus-research/direct-source",
        innerRunDir: "/srv/alphabook/logs/corpus-research/direct-source/inner",
        artifacts: [
          { name: "briefing.md", path: "/tmp/briefing.md", bytes: 32, updatedAt: now },
          { name: "hits/index.json", path: "/tmp/hits-index.json", bytes: 120, updatedAt: now },
          { name: "final-answer.md", path: "/tmp/final-answer.md", bytes: 320, updatedAt: now },
          { name: "final-answer.json", path: "/tmp/final-answer.json", bytes: 540, updatedAt: now },
          { name: "hermes.session.json", path: "/tmp/hermes.session.json", bytes: 80, updatedAt: now },
        ],
      }), { status: 200, headers: { "content-type": "application/json" } });
    }
    if (url.endsWith("/artifacts/briefing.md") && method === "GET") {
      return new Response(JSON.stringify({
        jobId: "job-hermes-direct-source",
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
        jobId: "job-hermes-direct-source",
        artifact: {
          name: "hits/index.json",
          path: "/tmp/hits-index.json",
          bytes: 120,
          updatedAt: now,
          content: JSON.stringify({
            mode: "small_scope_direct_read",
            direct_source_files: [
              "/mnt/alphabook_consolidation/final/20260402T044501Z/r2/gutenberg/clean/69530/clean.txt",
            ],
            hit_count: 0,
            hits: [],
          }),
        },
      }), { status: 200, headers: { "content-type": "application/json" } });
    }
    if (url.endsWith("/artifacts/final-answer.md") && method === "GET") {
      return new Response(JSON.stringify({
        jobId: "job-hermes-direct-source",
        artifact: {
          name: "final-answer.md",
          path: "/tmp/final-answer.md",
          bytes: 320,
          updatedAt: now,
          content: [
            "A joke still lands.",
            "",
            "## Representative Examples",
            "- **The Naked King**",
            '  > "Sire, to me it matters not whose son I am, therefore I tell you that you are riding without any clothes."',
            '  >',
            '  > (source: [clean.txt](/mnt/alphabook_consolidation/final/20260402T044501Z/r2/gutenberg/clean/69530/clean.txt), section “The Naked King”)',
          ].join("\n"),
        },
      }), { status: 200, headers: { "content-type": "application/json" } });
    }
    if (url.endsWith("/artifacts/final-answer.json") && method === "GET") {
      return new Response(JSON.stringify({
        jobId: "job-hermes-direct-source",
        artifact: {
          name: "final-answer.json",
          path: "/tmp/final-answer.json",
          bytes: 540,
          updatedAt: now,
          content: JSON.stringify({
            representative_examples: [
              {
                title: "The Naked King",
                author: "Don Juan Manuel",
                period: "14th century",
                point: "Status panic.",
                quote: "\"Sire, to me it matters not whose son I am, therefore I tell you that you are riding without any clothes.\"",
                citation: "direct-source:/mnt/alphabook_consolidation/final/20260402T044501Z/r2/gutenberg/clean/69530/clean.txt#The Naked King",
              },
            ],
          }),
        },
      }), { status: 200, headers: { "content-type": "application/json" } });
    }
    if (url.endsWith("/artifacts/hermes.session.json") && method === "GET") {
      return new Response(JSON.stringify({
        jobId: "job-hermes-direct-source",
        artifact: {
          name: "hermes.session.json",
          path: "/tmp/hermes.session.json",
          bytes: 80,
          updatedAt: now,
          content: JSON.stringify({ session_id: "hermes-session-2", messages: [] }),
        },
      }), { status: 200, headers: { "content-type": "application/json" } });
    }
    throw new Error(`Unexpected fetch: ${method} ${url}`);
  }) as typeof fetch;

  try {
    const store = new InMemoryAppStore(
      [
        {
          id: "local-gutenberg-69530",
          gutenbergId: 69530,
          title: "The humour of Spain",
          language: "en",
          releaseDate: "1920-01-01",
          rightsStatus: "public_domain",
          summary: "Spanish humor anthology.",
          authors: ["Anonymous"],
        } as never,
      ],
      [
        {
          id: "chunk-spain-1",
          workId: "local-gutenberg-69530",
          chunkIndex: 14,
          text: "Sire, to me it matters not whose son I am, therefore I tell you that you are riding without any clothes.",
          r2Key: "gutenberg/clean/69530/chunks.jsonl",
          score: 0,
          excerpt: "Sire, to me it matters not whose son I am, therefore I tell you that you are riding without any clothes.",
          readerPath: "/69530/passages/naked-king",
        } as never,
      ],
    );
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
        query: "What can I take from this humor anthology?",
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
    assert.match(finalAssistant.content, /\[Open passage\]\(https:\/\/alpha-book\.org\/\?view=explore&work=local-gutenberg-69530(?:&session=[^)]+)?&reader=%2F69530%2Fpassages%2Fnaked-king\)/);
    assert.doesNotMatch(finalAssistant.content, /\[clean\.txt\]\(\/mnt\/alphabook_consolidation\/.+\/clean\.txt\)/);
    const citations = Array.isArray(finalAssistant.metadata?.citations) ? finalAssistant.metadata.citations as Array<Record<string, unknown>> : [];
    assert.equal(citations.length, 1);
    assert.equal(citations[0]?.workId, "local-gutenberg-69530");
    assert.equal(citations[0]?.chunkId, "chunk-spain-1");
  } finally {
    globalThis.fetch = originalFetch;
  }
});
