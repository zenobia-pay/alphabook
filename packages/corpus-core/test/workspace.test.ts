import test from "node:test";
import assert from "node:assert/strict";

import type { CorpusAdapter } from "../src/domain";
import {
  normalizeWorkspaceChunks,
  normalizeWorkspaceDocuments,
  withLegacyWorkAliases,
} from "../src/workspace";

test("normalizeWorkspaceDocuments maps legacy works into generic documents", () => {
  const documents = normalizeWorkspaceDocuments({
    works: [{
      workId: "work-1",
      title: "Book One",
      authors: ["Author One"],
      releaseDate: "1901-01-01",
      summary: "Summary",
      cleanTextKey: "books/work-1/clean.txt",
      chunksKey: "chunks/work-1/chunks.jsonl",
    }],
  });

  assert.deepEqual(documents, [{
    documentId: "work-1",
    title: "Book One",
    contributors: ["Author One"],
    language: null,
    publishedAt: "1901-01-01",
    rightsStatus: null,
    summary: "Summary",
    subjects: [],
    cleanTextKey: "books/work-1/clean.txt",
    chunksKey: "chunks/work-1/chunks.jsonl",
  }]);
});

test("normalizeWorkspaceChunks maps legacy work ids into generic document ids", () => {
  const chunks = normalizeWorkspaceChunks({
    selectedChunks: [{
      id: "chunk-1",
      workId: "work-1",
      chunkIndex: 0,
      text: "hello",
      excerpt: "hello",
      r2Key: "r2/chunk-1",
    }],
  });

  assert.deepEqual(chunks, [{
    id: "chunk-1",
    documentId: "work-1",
    chunkIndex: 0,
    text: "hello",
    excerpt: "hello",
    r2Key: "r2/chunk-1",
    metadata: undefined,
  }]);
});

test("withLegacyWorkAliases preserves the existing AlphaBook work-shaped manifest", () => {
  const manifest = withLegacyWorkAliases({
    runtimeId: "runtime-1",
    sessionId: "session-1",
    documents: [{
      documentId: "doc-1",
      title: "Document One",
      contributors: ["Researcher"],
      cleanTextKey: "documents/doc-1.txt",
      chunksKey: "documents/doc-1.jsonl",
    }],
    fileCatalog: [{
      documentId: "doc-1",
      kind: "clean",
      r2Key: "documents/doc-1.txt",
      destinationPath: "books/doc-1/clean.txt",
    }],
    selectedChunkIds: ["chunk-1"],
    selectedChunks: [{
      id: "chunk-1",
      documentId: "doc-1",
      chunkIndex: 2,
      text: "Quoted text",
      excerpt: "Quoted text",
    }],
    taskContext: { phase: "test" },
  });

  assert.equal(manifest.works[0]?.workId, "doc-1");
  assert.deepEqual(manifest.works[0]?.authors, ["Researcher"]);
  assert.equal(manifest.fileCatalog?.[0]?.workId, "doc-1");
  assert.equal(manifest.selectedChunks?.[0]?.workId, "doc-1");
});

test("a non-book fixture adapter satisfies the generic corpus adapter contract", () => {
  const fixtureAdapter: CorpusAdapter = {
    id: "fixture-reports",
    displayName: "Fixture Reports",
    description: "Non-book smoke-test corpus adapter.",
    artifactKeys: {
      rawText: (id) => `fixture/raw/${id}.txt`,
      rawMetadata: (id) => `fixture/raw/${id}.json`,
      cleanText: (id) => `fixture/clean/${id}.txt`,
      chunks: (id) => `fixture/clean/${id}.jsonl`,
      renderedDocument: (id) => `fixture/rendered/${id}.html`,
    },
    text: {
      stripSourceBoilerplate: (text) => text.replace(/^REPORT:\s*/u, ""),
      normalizeText: (text) => text.trim(),
      chunkText: (text) => [text],
    },
  };

  assert.equal(fixtureAdapter.artifactKeys.rawText("42"), "fixture/raw/42.txt");
  assert.equal(fixtureAdapter.text.stripSourceBoilerplate("REPORT: hello"), "hello");
});
