import test from "node:test";
import assert from "node:assert/strict";

import type { CorpusAdapter } from "@alphabook/corpus-core";

import {
  createCorpusAdapterRegistry,
  toLegacyChatRequest,
  toLegacyToolArgs,
  toLegacyToolName,
  toPlatformChatRequest,
  toPlatformToolArgs,
  toPlatformToolName,
} from "../src/index";

test("adapter registry resolves registered adapters and default adapter", () => {
  const alpha: CorpusAdapter = {
    id: "alpha",
    displayName: "Alpha",
    description: "Alpha adapter",
    artifactKeys: {
      rawText: (id) => `alpha/${id}/raw.txt`,
      rawMetadata: (id) => `alpha/${id}/metadata.json`,
      cleanText: (id) => `alpha/${id}/clean.txt`,
      chunks: (id) => `alpha/${id}/chunks.jsonl`,
    },
    text: {
      stripSourceBoilerplate: (text) => text,
      normalizeText: (text) => text,
      chunkText: (text) => [text],
    },
  };
  const registry = createCorpusAdapterRegistry({ adapters: [alpha], defaultAdapterId: "alpha" });

  assert.equal(registry.get("alpha")?.displayName, "Alpha");
  assert.equal(registry.getDefault()?.id, "alpha");
  assert.equal(registry.list().length, 1);
});

test("platform tool aliases translate between generic and AlphaBook names", () => {
  assert.equal(toLegacyToolName("search_documents"), "search_works");
  assert.equal(toPlatformToolName("get_work_metadata"), "get_document_metadata");
  assert.equal(toPlatformToolName("unknown"), null);
});

test("platform contract helpers translate between work and document args", () => {
  assert.deepEqual(
    toPlatformToolArgs("get_work_metadata", { workIds: ["work-1"] }),
    { documentIds: ["work-1"] },
  );
  assert.deepEqual(
    toLegacyToolArgs("get_document_text", { documentId: "doc-1" }),
    { documentId: "doc-1", workId: "doc-1" },
  );
  assert.deepEqual(
    toPlatformChatRequest({ message: "hello", workIds: ["work-1"] }),
    { message: "hello", documentIds: ["work-1"] },
  );
  assert.deepEqual(
    toLegacyChatRequest({ message: "hello", documentIds: ["doc-1"] }),
    { message: "hello", documentIds: ["doc-1"], workIds: ["doc-1"] },
  );
});
