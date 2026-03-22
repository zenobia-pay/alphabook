import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import {
  benchmarkCorpusFromWorkspaceManifest,
  loadBeirBenchmarkDataset,
} from "../src/index";

test("workspace manifests convert into benchmark corpora", () => {
  const corpus = benchmarkCorpusFromWorkspaceManifest({
    runtimeId: "runtime-123",
    sessionId: "session-123",
    documents: [
      {
        documentId: "doc-1",
        title: "Doc One",
        summary: "A summary",
        language: "en",
        rightsStatus: "public",
        contributors: ["A. Author"],
        subjects: ["topic"],
        metadata: { year: 2024 },
      },
    ],
    selectedChunkIds: ["chunk-1"],
    selectedChunks: [
      {
        id: "chunk-1",
        documentId: "doc-1",
        chunkIndex: 0,
        text: "Long text body",
        excerpt: "Long text body",
        metadata: { year: 2024 },
      },
    ],
    taskContext: {},
  });

  assert.equal(corpus.id, "workspace-runtime-123");
  assert.equal(corpus.documents[0]?.id, "doc-1");
  assert.equal(corpus.passages[0]?.id, "chunk-1");
});

test("BEIR-style datasets load into corpus and query-set artifacts", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "alphabook-beir-"));
  try {
    await mkdir(root, { recursive: true });
    await writeFile(path.join(root, "corpus.jsonl"), [
      JSON.stringify({ _id: "doc-1", title: "Alpha", text: "alpha body", metadata: { split: "test" } }),
      JSON.stringify({ _id: "doc-2", title: "Beta", text: "beta body" }),
    ].join("\n"));
    await writeFile(path.join(root, "queries.jsonl"), [
      JSON.stringify({ _id: "q1", text: "alpha query" }),
      JSON.stringify({ _id: "q2", text: "beta query" }),
    ].join("\n"));
    await writeFile(path.join(root, "qrels.tsv"), [
      "query-id\tcorpus-id\tscore",
      "q1\tdoc-1\t2",
      "q2\tdoc-2\t1",
    ].join("\n"));

    const loaded = await loadBeirBenchmarkDataset(root, {
      defaultFamily: "paraphrase",
    });

    assert.equal(loaded.corpus.documents.length, 2);
    assert.equal(loaded.corpus.passages[0]?.id, "doc-1#p0");
    assert.equal(loaded.querySet.queries.length, 2);
    assert.equal(loaded.querySet.queries[0]?.family, "paraphrase");
    assert.deepEqual(loaded.querySet.queries[0]?.labels, [{ passageId: "doc-1#p0", grade: 2 }]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
