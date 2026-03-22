import test from "node:test";
import assert from "node:assert/strict";

import { gutenbergCorpusAdapter } from "../src/adapter";

test("gutenberg adapter exposes the legacy storage layout through the generic adapter contract", () => {
  assert.equal(gutenbergCorpusAdapter.id, "gutenberg");
  assert.equal(gutenbergCorpusAdapter.artifactKeys.rawText("123"), "gutenberg/raw/123/raw.txt");
  assert.equal(gutenbergCorpusAdapter.artifactKeys.cleanText("123"), "gutenberg/clean/123/clean.txt");
  assert.equal(gutenbergCorpusAdapter.artifactKeys.renderedDocument?.("123"), "gutenberg/clean/123/book.html");
  assert.equal(gutenbergCorpusAdapter.artifactKeys.renderedManifest?.("123"), "gutenberg/clean/123/book/manifest.json");
});

test("gutenberg adapter text hooks preserve current cleanup behavior", () => {
  const input = [
    "*** START OF THE PROJECT GUTENBERG EBOOK SAMPLE ***",
    "Project Gutenberg's eBook Sample",
    "",
    "Actual body text.",
    "",
    "*** END OF THE PROJECT GUTENBERG EBOOK SAMPLE ***",
  ].join("\n");

  assert.equal(gutenbergCorpusAdapter.text.stripSourceBoilerplate(input), "Actual body text.");
  assert.deepEqual(gutenbergCorpusAdapter.text.chunkText("Paragraph one.\n\nParagraph two.", 40), [
    "Paragraph one.\n\nParagraph two.",
  ]);
});

test("gutenberg adapter exposes book-specific retrieval hooks behind the generic contract", () => {
  assert.ok(gutenbergCorpusAdapter.hooks?.expandQueryTerms?.({
    query: "grief in novels",
    mode: "metadata",
  })?.includes("mourning"));
  assert.equal(
    gutenbergCorpusAdapter.hooks?.recommendedShardAxis?.({
      query: "authors writing about grief",
      estimatedDocumentBreadth: 128,
    }),
    "author_initial",
  );
});
