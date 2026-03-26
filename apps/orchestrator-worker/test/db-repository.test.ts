import test from "node:test";
import assert from "node:assert/strict";

import { SqlCorpusDbRepository } from "../src/db-repository";

test("SQL corpus repository maps work rows into neutral document and file records", async () => {
  const queries: string[] = [];
  const repository = new SqlCorpusDbRepository({
    async query(sql: string) {
      queries.push(sql);
      if (sql.includes("WHERE w.id = ANY")) {
        return {
          rows: [{
            id: "work-1",
            gutenberg_id: 42,
            title: "Sample Book",
            metadata_json: { shelf: "fiction" },
            language: "en",
            release_date: "1900-01-01",
            rights_status: "public_domain",
            summary: "Sample summary",
            authors: ["Jane Doe"],
            subjects: ["testing"],
            score: 0,
          }],
        };
      }
      if (sql.includes("FROM work_files") && sql.includes("kind = 'clean'")) {
        return {
          rows: [{
            work_id: "work-1",
            r2_key: "gutenberg/clean/42/clean.txt",
          }],
        };
      }
      if (sql.includes("FROM work_files")) {
        return {
          rows: [{
            work_id: "work-1",
            kind: "clean",
            r2_key: "gutenberg/clean/42/clean.txt",
            byte_size: 1234,
            metadata_json: {},
          }],
        };
      }
      if (sql.includes("COUNT(*)::text AS count")) {
        return { rows: [{ count: "1" }] };
      }
      return { rows: [] };
    },
  } as never);

  const [documents, files, textFile, count] = await Promise.all([
    repository.getDocumentMetadata(["work-1"]),
    repository.getDocumentFiles(["work-1"], ["clean"]),
    repository.getDocumentTextFile("work-1"),
    repository.countDocuments(),
  ]);

  assert.equal(documents[0]?.id, "work-1");
  assert.equal(documents[0]?.externalId, 42);
  assert.deepEqual(documents[0]?.contributors, ["Jane Doe"]);
  assert.equal(files[0]?.documentId, "work-1");
  assert.equal(textFile?.documentId, "work-1");
  assert.equal(count, 1);
  assert.ok(queries.length >= 3);
});
