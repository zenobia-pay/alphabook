import test from "node:test";
import assert from "node:assert/strict";

import {
  fixtureCorpusAdapter,
  fixtureDocuments,
} from "../src/index";
import { createFixtureCorpusRepository } from "../src/repository";

test("fixture adapter exposes a non-book storage layout and capabilities", () => {
  assert.equal(fixtureCorpusAdapter.id, "fixture");
  assert.equal(fixtureCorpusAdapter.capabilities?.renderedDocuments, true);
  assert.equal(fixtureCorpusAdapter.artifactKeys.renderedDocument?.("memo-1"), "fixture/clean/memo-1/document.html");
});

test("fixture adapter normalizes text and exposes example fixture documents", () => {
  assert.equal(fixtureCorpusAdapter.text.stripSourceBoilerplate("SOURCE: hello"), "hello");
  assert.equal(fixtureDocuments[0]?.title, "Incident Memo");
  assert.deepEqual(fixtureCorpusAdapter.hooks?.normalizeQuery?.("books about incidents"), {
    normalizedQuery: "documents about incidents",
    filters: undefined,
  });
});

test("fixture repository exposes a minimal non-book corpus through the platform repository contract", async () => {
  const repository = createFixtureCorpusRepository();

  const [documents, chunks, files, textFile] = await Promise.all([
    repository.searchDocuments("incident documents"),
    repository.getRelevantChunks("incident", ["memo-1"], 4),
    repository.getDocumentFiles(["memo-1"], ["clean", "chunks"]),
    repository.getDocumentTextFile("memo-1"),
  ]);

  assert.equal(documents[0]?.id, "memo-1");
  assert.equal(chunks[0]?.documentId, "memo-1");
  assert.equal(files.length, 2);
  assert.deepEqual(textFile, {
    documentId: "memo-1",
    r2Key: "fixture/clean/memo-1/clean.txt",
  });
});
