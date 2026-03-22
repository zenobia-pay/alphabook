import test from "node:test";
import assert from "node:assert/strict";

import { fixtureCorpusAdapter } from "@alphabook/source-fixture";

import {
  buildSimpleRenderedArtifactBundle,
  prepareCorpusIngest,
} from "../src/corpus-ingest";

test("prepareCorpusIngest derives generic artifact keys and metadata from an adapter", () => {
  const prepared = prepareCorpusIngest(fixtureCorpusAdapter, {
    adapterId: fixtureCorpusAdapter.id,
    externalId: "memo-1",
    title: "Incident Memo",
    rawSource: "SOURCE: Incident memo\n\nLatency increased.",
    rawText: "SOURCE: Incident memo\n\nLatency increased.",
    sourceFormat: "text",
    authors: ["Operations Team"],
    subjects: ["incidents"],
    rightsStatus: "internal",
    summary: "A short memo.",
    metadata: {
      category: "memo",
    },
  });

  assert.equal(prepared.cleanKey, "fixture/clean/memo-1/clean.txt");
  assert.equal(prepared.chunksKey, "fixture/clean/memo-1/chunks.jsonl");
  assert.equal(prepared.metadataPayload.corpusAdapterId, "fixture");
  assert.equal(prepared.metadataPayload.externalId, "memo-1");
  assert.equal(prepared.renderedDocumentKey, "fixture/clean/memo-1/document.html");
  assert.ok(prepared.renderedArtifacts);
});

test("buildSimpleRenderedArtifactBundle creates a one-page rendered document bundle", () => {
  const bundle = buildSimpleRenderedArtifactBundle({
    externalId: "memo-1",
    title: "Incident Memo",
    authors: ["Operations Team"],
    summary: "A short memo.",
    cleanText: "Paragraph one.\n\nParagraph two.",
  });

  assert.equal(bundle.pageFiles.length, 1);
  assert.match(bundle.landingHtml, /Incident Memo/);
  assert.match(bundle.manifestJson, /pageCount/);
});
