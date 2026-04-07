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
    }),
  });

  assert.equal(response.status, 200);
  const body = await response.text();
  assert.match(body, /search_documents/);
  assert.match(body, /"documentId":"work-1"/);
  assert.doesNotMatch(body, /"toolName":"search_works"/);
});
