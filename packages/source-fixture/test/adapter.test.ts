import test from "node:test";
import assert from "node:assert/strict";

import { fixtureCorpusAdapter, fixtureDocuments } from "../src/index";

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
