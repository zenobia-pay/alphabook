import test from "node:test";
import assert from "node:assert/strict";

import {
  createResearchTaskLeaseRenewer,
  runQueuedRemoteSemanticSearch,
  runQueuedWorkspaceResearchTask,
  shouldHandleLocallyWhenOriginProxyEnabled,
} from "../src/index";

test("origin proxy keeps auth and session endpoints on the local worker", () => {
  assert.equal(shouldHandleLocallyWhenOriginProxyEnabled("/auth/sign-in"), true);
  assert.equal(shouldHandleLocallyWhenOriginProxyEnabled("/auth/callback"), true);
  assert.equal(shouldHandleLocallyWhenOriginProxyEnabled("/me"), true);
  assert.equal(shouldHandleLocallyWhenOriginProxyEnabled("/health"), true);
  assert.equal(shouldHandleLocallyWhenOriginProxyEnabled("/sessions"), false);
  assert.equal(shouldHandleLocallyWhenOriginProxyEnabled("/api/v1/documents"), false);
});

test("queued workspace research dispatches sprite fanout tasks to the sprite runtime lane", async () => {
  const calls: string[] = [];
  const runtimeGateway = {
    async runWorkspaceTask() {
      calls.push("workspace");
      return { ok: true, runtimeId: "workspace-1" };
    },
    async runSpriteFanoutResearch(args: Record<string, unknown>) {
      calls.push("sprite");
      return {
        ok: true,
        runtimeId: typeof args.runtimeId === "string" ? args.runtimeId : "missing",
        briefing: "Sprite aggregate briefing.",
      };
    },
  } as const;

  const result = await runQueuedWorkspaceResearchTask(runtimeGateway as never, {
    runtimeId: "sprite-fanout:run-1",
    taskSpec: {
      mode: "sprite_fanout",
      question: "Compare grief across the corpus.",
      intensity: "maximum",
      workIds: ["work-1", "work-2"],
    },
    sessionId: "session-1",
    runId: "run-1",
    implementationId: "alphabook",
    progressReporter: async () => {},
  });

  assert.deepEqual(calls, ["sprite"]);
  assert.equal((result as Record<string, unknown>).ok, true);
  assert.equal((result as Record<string, unknown>).runtimeId, "sprite-fanout:run-1");
});

test("queued workspace research dispatches non-sprite tasks to the normal runtime lane", async () => {
  const calls: string[] = [];
  const runtimeGateway = {
    async runWorkspaceTask(args: Record<string, unknown>) {
      calls.push("workspace");
      return {
        ok: true,
        runtimeId: typeof args.runtimeId === "string" ? args.runtimeId : "missing",
        briefing: "Workspace briefing.",
      };
    },
  } as const;

  const result = await runQueuedWorkspaceResearchTask(runtimeGateway as never, {
    runtimeId: "runtime-1",
    taskSpec: {
      mode: "collect_and_brief",
      question: "Find passages about revenge.",
    },
    sessionId: "session-1",
    runId: "run-1",
    implementationId: "alphabook",
    progressReporter: async () => {},
  });

  assert.deepEqual(calls, ["workspace"]);
  assert.equal((result as Record<string, unknown>).ok, true);
  assert.equal((result as Record<string, unknown>).runtimeId, "runtime-1");
});

test("research task lease renewer keeps refreshing during long waits and stops cleanly", async () => {
  let renewals = 0;
  const renewer = createResearchTaskLeaseRenewer(async () => {
    renewals += 1;
  }, 10);

  renewer.start();
  await new Promise((resolve) => setTimeout(resolve, 35));
  await renewer.stop();
  const observedRenewals = renewals;
  await new Promise((resolve) => setTimeout(resolve, 25));

  assert.ok(observedRenewals >= 2);
  assert.equal(renewals, observedRenewals);
});

test("queued remote semantic search streams droplet logs and builds AlphaBook results", async () => {
  const originalFetch = globalThis.fetch;
  const requests: Array<{ url: string; method: string; body: string | null }> = [];
  const progress: string[] = [];
  let jobPolls = 0;

  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? "GET";
    const body = typeof init?.body === "string" ? init.body : null;
    requests.push({ url, method, body });

    if (url === "https://jobs.example/v1/jobs" && method === "POST") {
      return new Response(JSON.stringify({
        job: {
          id: "job-123",
          state: "running",
          running: true,
          pid: 111,
        },
      }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }

    if (url.startsWith("https://jobs.example/v1/jobs/job-123/logs")) {
      assert.match(url, /mode=all/);
      return new Response(JSON.stringify({
        jobId: "job-123",
        nextCursor: "cursor-2",
        sources: [
          {
            name: "inner/timing-log.jsonl",
            path: "/srv/alphabook/logs/semantic-search/job-123/timing-log.jsonl",
            bytes: 128,
            updatedAt: "2026-04-07T05:00:00.000Z",
            lines: [
              JSON.stringify({
                event: "variant_started",
                variant_index: 1,
                total_variants: 3,
                variant: "diary",
              }),
              JSON.stringify({
                event: "variant_completed",
                variant_index: 1,
                total_variants: 3,
                variant: "diary",
                match_count: 120,
                elapsed_seconds: 4.2,
              }),
            ],
          },
          {
            name: "inner/run.log",
            path: "/srv/alphabook/logs/semantic-search/job-123/run.log",
            bytes: 128,
            updatedAt: "2026-04-07T05:00:00.000Z",
            lines: [
              "2026-04-07T05:00:00Z Starting Qdrant retrieval for semantic search.",
              "2026-04-07T05:00:04Z Retrieved 2 reranked packets.",
            ],
          },
        ],
      }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }

    if (url === "https://jobs.example/v1/jobs/job-123" && method === "GET") {
      jobPolls += 1;
      return new Response(JSON.stringify({
        job: {
          id: "job-123",
          state: jobPolls >= 2 ? "completed" : "running",
          running: jobPolls < 2,
          pid: jobPolls < 2 ? 111 : null,
          detail: jobPolls >= 2 ? "Completed." : "Running retrieval.",
        },
      }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }

    if (url === "https://jobs.example/v1/jobs/job-123/artifacts/reranked-packets.jsonl" && method === "GET") {
      return new Response(JSON.stringify({
        jobId: "job-123",
        artifact: {
          name: "reranked-packets.jsonl",
          path: "/srv/alphabook/logs/semantic-search/job-123/reranked-packets.jsonl",
          bytes: 512,
          updatedAt: "2026-04-07T05:00:05.000Z",
          content: [
            JSON.stringify({
              gutenberg_id: "100",
              title: "The Journal of Example Travels",
              packet_text: "Day by day entries describe storms, illness, and survival.",
              packet_excerpt: "Day by day entries describe storms, illness, and survival.",
              start_chunk_index: 3,
              rerank_score: 0.91,
              source_ids: ["gutenberg:100:3"],
            }),
            JSON.stringify({
              gutenberg_id: "200",
              title: "A Young Lady's Diary",
              packet_text: "The diary mixes ordinary social detail with sharp observations.",
              packet_excerpt: "The diary mixes ordinary social detail with sharp observations.",
              start_chunk_index: 7,
              rerank_score: 0.83,
              source_ids: ["gutenberg:200:7"],
            }),
          ].join("\n"),
        },
      }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }

    throw new Error(`Unexpected fetch: ${method} ${url}`);
  }) as typeof globalThis.fetch;

  try {
    const result = await runQueuedRemoteSemanticSearch({
      HERMES_JOB_API_URL: "https://jobs.example",
    } as never, {
      async getWorkMetadata(workIds: string[]) {
        return workIds.map((id) => ({
          id,
          gutenbergId: id === "work-1" ? 100 : 200,
          title: id === "work-1" ? "The Journal of Example Travels" : "A Young Lady's Diary",
          authors: id === "work-1" ? ["Ada Example"] : ["Beatrice Example"],
          subjects: [],
          language: "en",
          releaseDate: null,
          rightsStatus: "public_domain",
          summary: null,
          metadata: {},
          coverImageUrl: null,
          coverThumbnailUrl: null,
          canonicalUrl: null,
          hasAudio: false,
          documentId: id,
        }));
      },
    }, {
      query: "Find diaries and journals with interesting examples.",
      workIds: ["work-1", "work-2"],
      maxResults: 2,
      sessionId: "session-1",
      runId: "run-1",
      progressReporter: async (text) => {
        progress.push(text);
      },
    });

    const createRequest = requests.find((request) => request.url === "https://jobs.example/v1/jobs");
    assert.ok(createRequest);
    assert.match(createRequest.body ?? "", /"jobType":"semantic_search"/);
    assert.match(createRequest.body ?? "", /"gutenbergIds":\["100","200"\]/);

    assert.equal(result.remoteJobId, "job-123");
    assert.equal(result.remoteJobType, "semantic_search");
    assert.equal(result.chunks.length, 2);
    assert.equal(result.citations.length, 2);
    assert.match(result.briefing, /I found 2 strong packets/);
    assert.ok(progress.some((line) => line.includes("Forwarding semantic retrieval to the DigitalOcean search box.")));
    assert.ok(progress.some((line) => line.includes("Starting Qdrant retrieval for semantic search.")));
    assert.ok(progress.some((line) => line.includes("Qdrant variant 1/3 started: diary")));
    assert.ok(progress.some((line) => line.includes("Qdrant variant 1/3 completed with 120 matches in 4.2s: diary")));
    assert.ok(progress.some((line) => line.includes("Remote semantic retrieval finished. Writing the AlphaBook answer now.")));
  } finally {
    globalThis.fetch = originalFetch;
  }
});
