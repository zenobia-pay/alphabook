import test from "node:test";
import assert from "node:assert/strict";

import { createApp } from "../src/app";
import { createBillingService } from "../src/billing";
import { HashEmbedder } from "../src/embeddings";
import { MemoryBlobStore } from "../src/r2";
import { ScriptedPlanner } from "../src/planner";
import { ScriptedRouter } from "../src/router";
import { InMemoryAppStore } from "../src/store";
import type { SynthesisInput, SynthesisResult, Synthesizer } from "../src/synthesizer";

class EchoSynthesizer implements Synthesizer {
  async synthesize(input: SynthesisInput): Promise<SynthesisResult> {
    return {
      answer: input.plannerDraft ?? "No synthesized answer was available.",
      citations: input.plannerCitations,
    };
  }
}

test("document endpoints expose neutral document metadata and source payloads", async () => {
  const store = new InMemoryAppStore([
    {
      id: "work-1",
      gutenbergId: 42,
      title: "Sample Book",
      language: "en",
      releaseDate: "1900-01-01",
      rightsStatus: "public_domain",
      summary: "Sample summary",
      authors: ["Jane Doe"],
      subjects: ["testing"],
      metadata: {
        sourcePath: "/tmp/sample.txt",
        metadataPath: "/tmp/sample.json",
      },
      cleanTextKey: "gutenberg/clean/42/clean.txt",
    } as never,
  ]);
  const blobStore = new MemoryBlobStore();
  blobStore.seed("gutenberg/clean/42/clean.txt", "Sample clean text");

  const app = createApp({
    store,
    billing: createBillingService(store),
    blobStore,
  });

  const listResponse = await app.request("/api/v1/documents?offset=0&limit=12");
  assert.equal(listResponse.status, 200);
  const listPayload = await listResponse.json() as {
    documents: Array<{ id: string; externalId: number | null; contributors: string[]; publishedAt: string | null }>;
  };
  assert.equal(listPayload.documents[0]?.id, "work-1");
  assert.equal(listPayload.documents[0]?.externalId, 42);
  assert.deepEqual(listPayload.documents[0]?.contributors, ["Jane Doe"]);
  assert.equal(listPayload.documents[0]?.publishedAt, "1900-01-01");

  const detailResponse = await app.request("/api/v1/documents/work-1");
  assert.equal(detailResponse.status, 200);
  const detailPayload = await detailResponse.json() as {
    document: { id: string; contributors: string[] };
  };
  assert.equal(detailPayload.document.id, "work-1");
  assert.deepEqual(detailPayload.document.contributors, ["Jane Doe"]);

  const sourceResponse = await app.request("/api/v1/documents/work-1/source");
  assert.equal(sourceResponse.status, 200);
  const sourcePayload = await sourceResponse.json() as {
    source: { format: string; content: string; sourcePath: string | null; metadataPath: string | null } | null;
  };
  assert.equal(sourcePayload.source?.format, "text");
  assert.equal(sourcePayload.source?.content, "Sample clean text");
  assert.equal(sourcePayload.source?.sourcePath, "/tmp/sample.txt");
  assert.equal(sourcePayload.source?.metadataPath, "/tmp/sample.json");
});

test("document chat endpoint accepts documentIds and streams neutral tool aliases", async () => {
  const store = new InMemoryAppStore(
    [
      {
        id: "work-1",
        gutenbergId: 996,
        title: "Don Quixote",
        language: "en",
        releaseDate: "2000-01-01",
        rightsStatus: "public_domain",
        summary: "A novel about delusion, grief, and errantry.",
        authors: ["Miguel de Cervantes"],
        subjects: ["fiction", "melancholy"],
        cleanTextKey: "gutenberg/clean/996/clean.txt",
      } as never,
    ],
    [
      {
        id: "chunk-1",
        workId: "work-1",
        chunkIndex: 12,
        text: "Don Quixote speaks of grief and sadness in terms of knightly suffering.",
        r2Key: "gutenberg/clean/996/chunks.jsonl",
        score: 0,
        excerpt: "",
      } as never,
    ],
  );

  const app = createApp({
    store,
    billing: createBillingService(store),
    router: new ScriptedRouter([
      {
        type: "search",
        fullQuery: "books about sadness in fiction",
        executionMode: "semantic",
      },
    ]),
    planner: new ScriptedPlanner([
      {
        type: "tool_call",
        tool_name: "search_works",
        args: {
          query: "books about sadness in fiction",
        },
      },
      {
        type: "final_answer",
        answer: "Don Quixote is the strongest match.",
        citations: [
          {
            workId: "work-1",
            chunkId: "chunk-1",
            label: "Don Quixote#12",
            excerpt: "Don Quixote speaks of grief and sadness in terms of knightly suffering.",
            r2Key: "gutenberg/clean/996/chunks.jsonl",
          },
        ],
      },
    ]),
    embedder: new HashEmbedder(),
    synthesizer: new EchoSynthesizer(),
    blobStore: new MemoryBlobStore(),
    runtimeGateway: {
      async createWorkspace() {
        return { ok: false, error: "disabled" };
      },
      async runWorkspaceTask() {
        return { ok: false, error: "disabled" };
      },
      async readWorkspaceFile() {
        return { ok: false, error: "disabled" };
      },
      async listWorkspaceFiles() {
        return { ok: false, error: "disabled" };
      },
      async destroyWorkspace() {
        return { ok: false, error: "disabled" };
      },
    },
    queues: {
      ingestName: "alphabook-ingest",
      jobsName: "alphabook-jobs",
    },
  });

  const response = await app.request("/api/v1/documents/chat", {
    method: "POST",
    headers: {
      "content-type": "application/json",
    },
    body: JSON.stringify({
      userId: "11111111-1111-1111-1111-111111111111",
      message: "Find me books about sadness",
      documentIds: ["work-1"],
      mode: "semantic",
    }),
  });

  assert.equal(response.status, 200);
  const body = await response.text();
  assert.match(body, /search_documents/);
  assert.match(body, /"documentId":"work-1"/);
  assert.doesNotMatch(body, /"toolName":"search_works"/);
});

test("document chat infers Agentic mode from the raw message before runner selection", async () => {
  const originalFetch = globalThis.fetch;
  const hermesLaunchPayloads: unknown[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    if (url === "https://hermes.example.test/v1/jobs" && init?.method === "POST") {
      hermesLaunchPayloads.push(init.body ? JSON.parse(String(init.body)) : null);
      return new Response(JSON.stringify({
        job: {
          id: "job-hermes-search",
          state: "launching",
          running: true,
          pid: 1234,
          userPrompt: "search for personal diaries and use agentic search",
          model: "gpt-5.4",
          maxTurns: 60,
          launchedAt: new Date().toISOString(),
          startedAt: new Date().toISOString(),
          finishedAt: null,
          innerRunDir: "/srv/alphabook/logs/corpus-research/job-hermes-search",
          innerRunId: "job-hermes-search",
          hermesSessionId: "hermes-session",
          exitCode: null,
          heartbeatAt: new Date().toISOString(),
          phase: "launching",
          phaseProgressPct: 5,
          detail: null,
          manifestStatus: "initialized",
          chosenScope: "full corpus",
          scopeRationale: null,
          recordCounts: null,
        },
      }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    if (url === "https://hermes.example.test/v1/jobs/job-hermes-search") {
      return new Response(JSON.stringify({
        job: {
          id: "job-hermes-search",
          state: "completed",
          running: false,
          pid: 1234,
          userPrompt: "search for personal diaries and use agentic search",
          model: "gpt-5.4",
          maxTurns: 60,
          launchedAt: new Date().toISOString(),
          startedAt: new Date().toISOString(),
          finishedAt: new Date().toISOString(),
          innerRunDir: "/srv/alphabook/logs/corpus-research/job-hermes-search",
          innerRunId: "job-hermes-search",
          hermesSessionId: "hermes-session",
          exitCode: 0,
          heartbeatAt: new Date().toISOString(),
          phase: "completed",
          phaseProgressPct: 100,
          detail: null,
          manifestStatus: "completed",
          chosenScope: "full corpus",
          scopeRationale: null,
          recordCounts: null,
        },
      }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    if (url.startsWith("https://hermes.example.test/v1/jobs/job-hermes-search/logs")) {
      return new Response(JSON.stringify({
        jobId: "job-hermes-search",
        sources: [],
        nextCursor: "",
      }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    if (url === "https://hermes.example.test/v1/jobs/job-hermes-search/artifacts") {
      return new Response(JSON.stringify({
        jobId: "job-hermes-search",
        runDir: "/srv/alphabook/logs/corpus-research/job-hermes-search",
        innerRunDir: "/srv/alphabook/logs/corpus-research/job-hermes-search",
        artifacts: [
          {
            name: "briefing.md",
            path: "/srv/alphabook/logs/corpus-research/job-hermes-search/briefing.md",
            bytes: 28,
            updatedAt: new Date().toISOString(),
          },
          {
            name: "hits/index.json",
            path: "/srv/alphabook/logs/corpus-research/job-hermes-search/hits/index.json",
            bytes: 11,
            updatedAt: new Date().toISOString(),
          },
          {
            name: "hermes.session.json",
            path: "/srv/alphabook/logs/corpus-research/job-hermes-search/hermes.session.json",
            bytes: 80,
            updatedAt: new Date().toISOString(),
          },
        ],
      }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    if (url === "https://hermes.example.test/v1/jobs/job-hermes-search/artifacts/briefing.md") {
      return new Response(JSON.stringify({
        jobId: "job-hermes-search",
        artifact: {
          name: "briefing.md",
          path: "/srv/alphabook/logs/corpus-research/job-hermes-search/briefing.md",
          bytes: 28,
          updatedAt: new Date().toISOString(),
          content: "# Briefing\nInteresting diaries",
        },
      }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    if (url === "https://hermes.example.test/v1/jobs/job-hermes-search/artifacts/hits%2Findex.json") {
      return new Response(JSON.stringify({
        jobId: "job-hermes-search",
        artifact: {
          name: "hits/index.json",
          path: "/srv/alphabook/logs/corpus-research/job-hermes-search/hits/index.json",
          bytes: 11,
          updatedAt: new Date().toISOString(),
          content: "{\"hits\":[]}",
        },
      }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    if (url === "https://hermes.example.test/v1/jobs/job-hermes-search/artifacts/hermes.session.json") {
      return new Response(JSON.stringify({
        jobId: "job-hermes-search",
        artifact: {
          name: "hermes.session.json",
          path: "/srv/alphabook/logs/corpus-research/job-hermes-search/hermes.session.json",
          bytes: 94,
          updatedAt: new Date().toISOString(),
          content: JSON.stringify({
            session_id: "hermes-session",
            messages: [
              {
                role: "assistant",
                content: "Hermes found the strongest diary leads.",
              },
            ],
          }),
        },
      }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    return new Response(`Unhandled fetch: ${url}`, { status: 500 });
  }) as typeof fetch;

  try {
    const store = new InMemoryAppStore();
    const app = createApp({
      store,
      billing: createBillingService(store),
      blobStore: new MemoryBlobStore(),
      hermesJobApiUrl: "https://hermes.example.test",
      hermesJobApiToken: "test-token",
      queues: {
        ingestName: "alphabook-ingest",
        jobsName: "alphabook-jobs",
      },
    });

    const response = await app.request("/api/v1/documents/chat", {
      method: "POST",
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify({
        userId: "11111111-1111-1111-1111-111111111111",
        message: "search for personal diaries and use agentic search",
      }),
    });

    assert.equal(response.status, 200);
    const body = await response.text();
    assert.match(body, /event: assistant\.delta/);
    assert.match(body, /"completionMode":"agentic"/);
    assert.doesNotMatch(body, /semantic_deep_search/);
    assert.equal(hermesLaunchPayloads.length, 1);
    assert.equal((hermesLaunchPayloads[0] as { workflow?: string }).workflow, "search");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("document chat launches Agentic search from the router decision instead of falling through to semantic search", async () => {
  const originalFetch = globalThis.fetch;
  const hermesLaunchPayloads: unknown[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    if (url === "https://hermes.example.test/v1/jobs" && init?.method === "POST") {
      hermesLaunchPayloads.push(init.body ? JSON.parse(String(init.body)) : null);
      return new Response(JSON.stringify({
        job: {
          id: "job-agentic-from-router",
          state: "completed",
          running: false,
          pid: 1234,
          userPrompt: "what journals do you have in here? whose journals? Anyone interesting you can find for me? search for personal diaries",
          model: "gpt-5.4",
          maxTurns: 60,
          launchedAt: new Date().toISOString(),
          startedAt: new Date().toISOString(),
          finishedAt: new Date().toISOString(),
          innerRunDir: "/srv/alphabook/logs/corpus-search/job-agentic-from-router",
          innerRunId: "job-agentic-from-router",
          hermesSessionId: "agentic-session",
          exitCode: 0,
          heartbeatAt: new Date().toISOString(),
          phase: "completed",
          phaseProgressPct: 100,
          detail: null,
          manifestStatus: "completed",
          chosenScope: "full corpus",
          scopeRationale: null,
          recordCounts: null,
        },
      }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    if (url === "https://hermes.example.test/v1/jobs/job-agentic-from-router") {
      return new Response(JSON.stringify({
        job: {
          id: "job-agentic-from-router",
          state: "completed",
          running: false,
          pid: 1234,
          userPrompt: "what journals do you have in here? whose journals? Anyone interesting you can find for me? search for personal diaries",
          model: "gpt-5.4",
          maxTurns: 60,
          launchedAt: new Date().toISOString(),
          startedAt: new Date().toISOString(),
          finishedAt: new Date().toISOString(),
          innerRunDir: "/srv/alphabook/logs/corpus-search/job-agentic-from-router",
          innerRunId: "job-agentic-from-router",
          hermesSessionId: "agentic-session",
          exitCode: 0,
          heartbeatAt: new Date().toISOString(),
          phase: "completed",
          phaseProgressPct: 100,
          detail: null,
          manifestStatus: "completed",
          chosenScope: "full corpus",
          scopeRationale: null,
          recordCounts: null,
        },
      }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    if (url.startsWith("https://hermes.example.test/v1/jobs/job-agentic-from-router/logs")) {
      return new Response(JSON.stringify({
        jobId: "job-agentic-from-router",
        sources: [],
        nextCursor: "",
      }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    if (url === "https://hermes.example.test/v1/jobs/job-agentic-from-router/artifacts") {
      return new Response(JSON.stringify({
        jobId: "job-agentic-from-router",
        runDir: "/srv/alphabook/logs/corpus-search/job-agentic-from-router",
        innerRunDir: "/srv/alphabook/logs/corpus-search/job-agentic-from-router",
        artifacts: [
          {
            name: "briefing.md",
            path: "/srv/alphabook/logs/corpus-search/job-agentic-from-router/briefing.md",
            bytes: 32,
            updatedAt: new Date().toISOString(),
          },
          {
            name: "hits/index.json",
            path: "/srv/alphabook/logs/corpus-search/job-agentic-from-router/hits/index.json",
            bytes: 11,
            updatedAt: new Date().toISOString(),
          },
          {
            name: "hermes.session.json",
            path: "/srv/alphabook/logs/corpus-search/job-agentic-from-router/hermes.session.json",
            bytes: 84,
            updatedAt: new Date().toISOString(),
          },
        ],
      }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    if (url === "https://hermes.example.test/v1/jobs/job-agentic-from-router/artifacts/briefing.md") {
      return new Response(JSON.stringify({
        jobId: "job-agentic-from-router",
        artifact: {
          name: "briefing.md",
          path: "/srv/alphabook/logs/corpus-search/job-agentic-from-router/briefing.md",
          bytes: 32,
          updatedAt: new Date().toISOString(),
          content: "# Briefing\nJournal inventory ready",
        },
      }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    if (url === "https://hermes.example.test/v1/jobs/job-agentic-from-router/artifacts/hits%2Findex.json") {
      return new Response(JSON.stringify({
        jobId: "job-agentic-from-router",
        artifact: {
          name: "hits/index.json",
          path: "/srv/alphabook/logs/corpus-search/job-agentic-from-router/hits/index.json",
          bytes: 11,
          updatedAt: new Date().toISOString(),
          content: "{\"hits\":[]}",
        },
      }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    if (url === "https://hermes.example.test/v1/jobs/job-agentic-from-router/artifacts/hermes.session.json") {
      return new Response(JSON.stringify({
        jobId: "job-agentic-from-router",
        artifact: {
          name: "hermes.session.json",
          path: "/srv/alphabook/logs/corpus-search/job-agentic-from-router/hermes.session.json",
          bytes: 94,
          updatedAt: new Date().toISOString(),
          content: JSON.stringify({
            session_id: "agentic-session",
            messages: [
              {
                role: "assistant",
                content: "The agentic run searched the journal corpus directly.",
              },
            ],
          }),
        },
      }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    return new Response(`Unhandled fetch: ${url}`, { status: 500 });
  }) as typeof fetch;

  try {
    const store = new InMemoryAppStore();
    const app = createApp({
      store,
      billing: createBillingService(store),
      blobStore: new MemoryBlobStore(),
      router: new ScriptedRouter([
        {
          type: "search",
          fullQuery: "what journals do you have in here? whose journals? Anyone interesting you can find for me? search for personal diaries",
          executionMode: "agentic",
        },
      ]),
      hermesJobApiUrl: "https://hermes.example.test",
      hermesJobApiToken: "test-token",
      queues: {
        ingestName: "alphabook-ingest",
        jobsName: "alphabook-jobs",
      },
    });

    const response = await app.request("/api/v1/documents/chat", {
      method: "POST",
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify({
        userId: "11111111-1111-1111-1111-111111111111",
        message: "what journals do you have in here? whose journals? Anyone interesting you can find for me? search for personal diaries",
      }),
    });

    assert.equal(response.status, 200);
    const body = await response.text();
    assert.match(body, /event: assistant\.delta/);
    assert.match(body, /"completionMode":"agentic"/);
    assert.match(body, /Journal inventory ready/);
    assert.doesNotMatch(body, /The agentic run searched the journal corpus directly\./);
    assert.doesNotMatch(body, /semantic_deep_search/);
    assert.equal(hermesLaunchPayloads.length, 1);
    assert.equal((hermesLaunchPayloads[0] as { workflow?: string }).workflow, "search");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("document chat runs app-side synthesis for Hermes search results when evidence hits are available", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    if (url === "https://hermes.example.test/v1/jobs" && init?.method === "POST") {
      return new Response(JSON.stringify({
        job: {
          id: "job-agentic-synthesized",
          state: "completed",
          running: false,
          pid: 1234,
          userPrompt: "find me an underrated railway story",
          model: "gpt-5.4",
          maxTurns: 60,
          launchedAt: new Date().toISOString(),
          startedAt: new Date().toISOString(),
          finishedAt: new Date().toISOString(),
          innerRunDir: "/srv/alphabook/logs/corpus-search/job-agentic-synthesized",
          innerRunId: "job-agentic-synthesized",
          hermesSessionId: "agentic-session",
          exitCode: 0,
          heartbeatAt: new Date().toISOString(),
          phase: "completed",
          phaseProgressPct: 100,
          detail: null,
          manifestStatus: "completed",
          chosenScope: "railway manuals",
          scopeRationale: null,
          recordCounts: null,
        },
      }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    if (url.startsWith("https://hermes.example.test/v1/jobs/job-agentic-synthesized/logs")) {
      return new Response(JSON.stringify({
        jobId: "job-agentic-synthesized",
        sources: [],
        nextCursor: "",
      }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    if (url === "https://hermes.example.test/v1/jobs/job-agentic-synthesized") {
      return new Response(JSON.stringify({
        job: {
          id: "job-agentic-synthesized",
          state: "completed",
          running: false,
          pid: 1234,
          userPrompt: "find me an underrated railway story",
          model: "gpt-5.4",
          maxTurns: 60,
          launchedAt: new Date().toISOString(),
          startedAt: new Date().toISOString(),
          finishedAt: new Date().toISOString(),
          innerRunDir: "/srv/alphabook/logs/corpus-search/job-agentic-synthesized",
          innerRunId: "job-agentic-synthesized",
          hermesSessionId: "agentic-session",
          exitCode: 0,
          heartbeatAt: new Date().toISOString(),
          phase: "completed",
          phaseProgressPct: 100,
          detail: null,
          manifestStatus: "completed",
          chosenScope: "railway manuals",
          scopeRationale: null,
          recordCounts: null,
        },
      }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    if (url === "https://hermes.example.test/v1/jobs/job-agentic-synthesized/artifacts") {
      return new Response(JSON.stringify({
        jobId: "job-agentic-synthesized",
        runDir: "/srv/alphabook/logs/corpus-search/job-agentic-synthesized",
        innerRunDir: "/srv/alphabook/logs/corpus-search/job-agentic-synthesized",
        artifacts: [
          {
            name: "briefing.md",
            path: "/srv/alphabook/logs/corpus-search/job-agentic-synthesized/briefing.md",
            bytes: 96,
            updatedAt: new Date().toISOString(),
          },
          {
            name: "hits/index.json",
            path: "/srv/alphabook/logs/corpus-search/job-agentic-synthesized/hits/index.json",
            bytes: 180,
            updatedAt: new Date().toISOString(),
          },
        ],
      }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    if (url === "https://hermes.example.test/v1/jobs/job-agentic-synthesized/artifacts/briefing.md") {
      return new Response(JSON.stringify({
        jobId: "job-agentic-synthesized",
        artifact: {
          name: "briefing.md",
          path: "/srv/alphabook/logs/corpus-search/job-agentic-synthesized/briefing.md",
          bytes: 96,
          updatedAt: new Date().toISOString(),
          content: "# Briefing\nA railway manual describes a rulebook failure that could split train orders.",
        },
      }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    if (url === "https://hermes.example.test/v1/jobs/job-agentic-synthesized/artifacts/hits%2Findex.json") {
      return new Response(JSON.stringify({
        jobId: "job-agentic-synthesized",
        artifact: {
          name: "hits/index.json",
          path: "/srv/alphabook/logs/corpus-search/job-agentic-synthesized/hits/index.json",
          bytes: 180,
          updatedAt: new Date().toISOString(),
          content: JSON.stringify({
            hits: [
              {
                hit_id: "hit-0001",
                source_title: "Train Dispatching",
                work_id: "work-railway",
                quote: "The fatal defect in the \"single order\" system is that the orders to the two trains...",
                chunk_id: "chunk-railway-1",
              },
            ],
          }),
        },
      }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    if (url.includes("/chunks/chunk-railway-1")) {
      return new Response(JSON.stringify({
        chunk: {
          id: "chunk-railway-1",
          workId: "work-railway",
          chunkIndex: 12,
          readerPath: "/read/12",
        },
      }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    return new Response(`Unhandled fetch: ${url}`, { status: 500 });
  }) as typeof fetch;

  try {
    const store = new InMemoryAppStore([
      {
        id: "work-railway",
        gutenbergId: 17783,
        title: "The Traveling Engineers' Association",
        language: "en",
        releaseDate: "1906-01-01",
        rightsStatus: "public_domain",
        summary: "Railway operating rules and exams.",
        authors: ["Anonymous"],
        subjects: ["railroads"],
      } as never,
    ]);
    const app = createApp({
      store,
      billing: createBillingService(store),
      blobStore: new MemoryBlobStore(),
      router: new ScriptedRouter([
        {
          type: "search",
          fullQuery: "find me an underrated railway story",
          executionMode: "agentic",
        },
      ]),
      synthesizer: {
        async synthesize() {
          return {
            answer: "The app-side synthesis picked up the railway evidence and turned it into a real answer with a quote.",
            citations: [
              {
                workId: "work-railway",
                chunkId: "chunk-railway-1",
                label: "Train Dispatching",
                excerpt: "The fatal defect in the \"single order\" system is that the orders to the two trains...",
              },
            ],
          };
        },
      },
      hermesJobApiUrl: "https://hermes.example.test",
      hermesJobApiToken: "test-token",
      queues: {
        ingestName: "alphabook-ingest",
        jobsName: "alphabook-jobs",
      },
    });

    const response = await app.request("/api/v1/documents/chat", {
      method: "POST",
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify({
        userId: "11111111-1111-1111-1111-111111111111",
        message: "find me an underrated railway story",
      }),
    });

    assert.equal(response.status, 200);
    const body = await response.text();
    assert.match(body, /app-side synthesis picked up the railway evidence/i);
    assert.doesNotMatch(body, /# Briefing/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("document chat launches Agentic search even when the user only says use agentic", async () => {
  const originalFetch = globalThis.fetch;
  const hermesLaunchPayloads: unknown[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    if (url === "https://hermes.example.test/v1/jobs" && init?.method === "POST") {
      hermesLaunchPayloads.push(init.body ? JSON.parse(String(init.body)) : null);
      return new Response(JSON.stringify({
        job: {
          id: "job-hermes-default-search",
          state: "completed",
          running: false,
          pid: 1234,
          userPrompt: "what journals do you have in here? use agentic.",
          model: "gpt-5.4",
          maxTurns: 60,
          launchedAt: new Date().toISOString(),
          startedAt: new Date().toISOString(),
          finishedAt: new Date().toISOString(),
          innerRunDir: "/srv/alphabook/logs/corpus-search/job-hermes-default-search",
          innerRunId: "job-hermes-default-search",
          hermesSessionId: "hermes-session",
          exitCode: 0,
          heartbeatAt: new Date().toISOString(),
          phase: "completed",
          phaseProgressPct: 100,
          detail: null,
          manifestStatus: "completed",
          chosenScope: "full corpus",
          scopeRationale: null,
          recordCounts: null,
        },
      }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    if (url === "https://hermes.example.test/v1/jobs/job-hermes-default-search") {
      return new Response(JSON.stringify({
        job: {
          id: "job-hermes-default-search",
          state: "completed",
          running: false,
          pid: 1234,
          userPrompt: "what journals do you have in here? use agentic.",
          model: "gpt-5.4",
          maxTurns: 60,
          launchedAt: new Date().toISOString(),
          startedAt: new Date().toISOString(),
          finishedAt: new Date().toISOString(),
          innerRunDir: "/srv/alphabook/logs/corpus-search/job-hermes-default-search",
          innerRunId: "job-hermes-default-search",
          hermesSessionId: "hermes-session",
          exitCode: 0,
          heartbeatAt: new Date().toISOString(),
          phase: "completed",
          phaseProgressPct: 100,
          detail: null,
          manifestStatus: "completed",
          chosenScope: "full corpus",
          scopeRationale: null,
          recordCounts: null,
        },
      }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    if (url.startsWith("https://hermes.example.test/v1/jobs/job-hermes-default-search/logs")) {
      return new Response(JSON.stringify({
        jobId: "job-hermes-default-search",
        sources: [
          {
            name: "launcher",
            path: "/srv/alphabook/logs/hermes-search/job-hermes-default-search/launcher.log",
            bytes: 120,
            updatedAt: new Date().toISOString(),
            lines: [
              "launching agentic search wrapper",
            ],
          },
          {
            name: "run_log",
            path: "/srv/alphabook/logs/corpus-search/job-hermes-default-search/run.log",
            bytes: 160,
            updatedAt: new Date().toISOString(),
            lines: [
              "Scoped 72644 files from the precomputed corpus index.",
            ],
          },
        ],
        nextCursor: "",
      }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    if (url === "https://hermes.example.test/v1/jobs/job-hermes-default-search/artifacts") {
      return new Response(JSON.stringify({
        jobId: "job-hermes-default-search",
        runDir: "/srv/alphabook/logs/hermes-search/job-hermes-default-search",
        innerRunDir: "/srv/alphabook/logs/corpus-search/job-hermes-default-search",
        artifacts: [],
      }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    if (url === "https://hermes.example.test/v1/jobs/job-hermes-default-search/artifacts/hermes.session.json") {
      return new Response(JSON.stringify({
        jobId: "job-hermes-default-search",
        artifact: {
          name: "hermes.session.json",
          path: "/srv/alphabook/logs/hermes-search/job-hermes-default-search/hermes.session.json",
          bytes: 94,
          updatedAt: new Date().toISOString(),
          content: JSON.stringify({
            session_id: "hermes-session",
            messages: [],
          }),
        },
      }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    return new Response(`Unhandled fetch: ${url}`, { status: 500 });
  }) as typeof fetch;

  try {
    const store = new InMemoryAppStore();
    const app = createApp({
      store,
      billing: createBillingService(store),
      blobStore: new MemoryBlobStore(),
      hermesJobApiUrl: "https://hermes.example.test",
      hermesJobApiToken: "test-token",
      queues: {
        ingestName: "alphabook-ingest",
        jobsName: "alphabook-jobs",
      },
    });

    const response = await app.request("/api/v1/documents/chat", {
      method: "POST",
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify({
        userId: "11111111-1111-1111-1111-111111111111",
        message: "what journals do you have in here? whose journals? use agentic.",
      }),
    });

    assert.equal(response.status, 200);
    const body = await response.text();
    assert.match(body, /event: assistant\.delta/);
    assert.match(body, /Agentic Search Progress/);
    assert.match(body, /Scoped 72644 files from the precomputed corpus index/);
    assert.equal(hermesLaunchPayloads.length, 1);
    assert.equal((hermesLaunchPayloads[0] as { workflow?: string }).workflow, "search");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("document chat marks the run failed when Hermes launch fails before polling starts", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    if (url === "https://hermes.example.test/v1/jobs" && init?.method === "POST") {
      return new Response(JSON.stringify({
        error: "internal_error",
        message: "mkdir: cannot create directory '/srv/alphabook/logs/hermes-corpus-research/xyz': No space left on device",
      }), {
        status: 500,
        headers: { "content-type": "application/json" },
      });
    }
    return new Response(`Unhandled fetch: ${url}`, { status: 500 });
  }) as typeof fetch;

  try {
    const store = new InMemoryAppStore();
    const app = createApp({
      store,
      billing: createBillingService(store),
      blobStore: new MemoryBlobStore(),
      hermesJobApiUrl: "https://hermes.example.test",
      hermesJobApiToken: "test-token",
      queues: {
        ingestName: "alphabook-ingest",
        jobsName: "alphabook-jobs",
      },
    });

    const response = await app.request("/api/v1/documents/chat", {
      method: "POST",
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify({
        userId: "11111111-1111-1111-1111-111111111111",
        message: "search for personal diaries and use agentic search",
      }),
    });

    assert.equal(response.status, 200);
    const body = await response.text();
    assert.match(body, /"status":"failed"/);
    assert.match(body, /No space left on device/);

    const sessions = await store.listSessions("11111111-1111-1111-1111-111111111111");
    const runs = await store.listRuns(sessions[0]!.id);
    assert.equal(runs[0]?.status, "failed");
  } finally {
    globalThis.fetch = originalFetch;
  }
});
