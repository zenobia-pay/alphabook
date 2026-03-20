import test from "node:test";
import assert from "node:assert/strict";

import type { CorpusAdapter } from "@alphabook/corpus-core";

import {
  createCorpusAdapterRegistry,
  toLegacyToolName,
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
