import test from "node:test";
import assert from "node:assert/strict";

import {
  createSupremeCourtRepository,
  supremeCourtCaseSources,
  supremeCourtCorpusAdapter,
} from "../src/index";

test("supreme court adapter exposes case-oriented storage layout", () => {
  assert.equal(supremeCourtCorpusAdapter.id, "supreme_court");
  assert.equal(
    supremeCourtCorpusAdapter.artifactKeys.renderedDocument?.("brown-v-board-1954"),
    "supreme-court/clean/brown-v-board-1954/case.html",
  );
});

test("supreme court repository supports metadata and chunk retrieval", async () => {
  const repository = createSupremeCourtRepository();

  const [documents, chunks, textFile] = await Promise.all([
    repository.searchDocuments("equal protection segregation"),
    repository.getRelevantChunks("right to remain silent", ["miranda-v-arizona-1966"], 4),
    repository.getDocumentTextFile("brown-v-board-1954"),
  ]);

  assert.equal(documents[0]?.id, "brown-v-board-1954");
  assert.equal(chunks[0]?.documentId, "miranda-v-arizona-1966");
  assert.equal(textFile?.r2Key, "supreme-court/clean/brown-v-board-1954/clean.txt");
  assert.match(supremeCourtCaseSources["new-york-times-v-sullivan-1964"], /actual malice/);
});
