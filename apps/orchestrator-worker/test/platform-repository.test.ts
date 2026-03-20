import test from "node:test";
import assert from "node:assert/strict";

import { createPlatformRepository } from "../src/platform-repository";
import { InMemoryAppStore } from "../src/store";

test("platform repository maps work metadata into neutral document metadata", async () => {
  const store = new InMemoryAppStore([
    {
      id: "work-1",
      gutenbergId: 42,
      title: "Sample Book",
      language: "en",
      releaseDate: "1900-01-01",
      rightsStatus: "public_domain",
      summary: "Sample summary",
      authors: ["Jane Doe"],
      subjects: ["testing"],
      metadata: {},
      cleanTextKey: "gutenberg/clean/42/clean.txt",
    } as never,
  ]);
  const repository = createPlatformRepository(store);

  const documents = await repository.getDocumentMetadata(["work-1"]);

  assert.equal(documents[0]?.id, "work-1");
  assert.equal(documents[0]?.externalId, 42);
  assert.deepEqual(documents[0]?.contributors, ["Jane Doe"]);
  assert.equal(documents[0]?.publishedAt, "1900-01-01");
});
