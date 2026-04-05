import assert from "node:assert/strict";
import test from "node:test";

import { getMissingRequiredArtifacts, parseChunkPayload, scanGutenbergR2Keys, validateChunkPayload } from "../src/rebuild";

test("scanGutenbergR2Keys identifies canonical ids and orphaned keys", () => {
  const result = scanGutenbergR2Keys([
    "gutenberg/raw/123/raw.txt",
    "gutenberg/raw/123/metadata.json",
    "gutenberg/clean/123/clean.txt",
    "gutenberg/clean/123/chunks.jsonl",
    "gutenberg/clean/123/book.html",
    "gutenberg/clean/00123/chunks/0.json",
    "gutenberg/clean/00123/book/manifest.json",
    "gutenberg/clean/00123/book/pages/page-0001.html",
    "gutenberg/raw/456/metadata.json",
    "gutenberg/clean/456/chunks.jsonl",
    "gutenberg/misc/weird.txt",
  ]);

  assert.deepEqual(result.canonicalIds, ["123"]);
  assert.deepEqual(result.idsMissingRequiredArtifacts, ["456"]);
  assert.deepEqual(result.orphanedKeys, ["gutenberg/misc/weird.txt"]);
  assert.deepEqual(
    getMissingRequiredArtifacts(result.byId.get("456") ?? { id: "456", keys: {}, unknownKeys: [] }),
    ["raw", "clean", "chunk_object", "book_html", "book_manifest", "book_page"],
  );
});

test("parseChunkPayload parses ndjson chunk payloads", () => {
  const result = parseChunkPayload([
    JSON.stringify({ id: "chunk-1", chunk_index: 0, text: "Alpha" }),
    JSON.stringify({ id: "chunk-2", chunk_index: 1, text: "Beta" }),
    "",
  ].join("\n"));

  assert.equal(result.length, 2);
  assert.equal(result[0]?.id, "chunk-1");
  assert.equal(result[1]?.text, "Beta");
});

test("validateChunkPayload finds duplicate ids, duplicate indexes, and empty text", () => {
  const issues = validateChunkPayload([
    { id: "chunk-1", chunk_index: 0, text: "Alpha" },
    { id: "chunk-1", chunk_index: 1, text: "Beta" },
    { id: "chunk-3", chunk_index: 1, text: "   " },
  ]);

  assert.deepEqual(
    issues.map((issue) => issue.code).sort(),
    ["duplicate_chunk_id", "duplicate_chunk_index", "empty_text"],
  );
});
