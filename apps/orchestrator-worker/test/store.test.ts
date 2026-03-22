import test from "node:test";
import assert from "node:assert/strict";

import { InMemoryAppStore } from "../src/store";

test("upsertUserProfile updates the existing user when the auth id is stable", async () => {
  const store = new InMemoryAppStore();

  const first = await store.upsertUserProfile({
    id: "stable-user-id",
    email: "reader@example.com",
    name: "Reader Before Update",
  });
  const second = await store.upsertUserProfile({
    id: "stable-user-id",
    email: "reader@example.com",
    name: "Reader After Update",
  });

  assert.equal(first.id, "stable-user-id");
  assert.equal(second.id, "stable-user-id");

  const profile = await store.getUserProfile("stable-user-id");
  assert.ok(profile);
  assert.equal(profile.name, "Reader After Update");
  assert.equal(profile.email, "reader@example.com");
});

test("notifications support dedupe, unread counts, and read transitions", async () => {
  const store = new InMemoryAppStore();
  await store.upsertUserProfile({
    id: "reader-1",
    email: "reader@example.com",
    name: "Reader",
  });

  const first = await store.createNotification({
    userId: "reader-1",
    type: "tool_started",
    title: "Research step started",
    body: "Search works started.",
    dedupeKey: "tool-start:1",
  });
  const duplicate = await store.createNotification({
    userId: "reader-1",
    type: "tool_started",
    title: "Research step started",
    body: "Search works started.",
    dedupeKey: "tool-start:1",
  });
  await store.createNotification({
    userId: "reader-1",
    type: "run_completed",
    title: "Research complete",
    body: "Your run is ready.",
    dedupeKey: "run-end:1:completed",
  });

  assert.equal(first.id, duplicate.id);
  assert.equal(await store.countUnreadNotifications("reader-1"), 2);

  const marked = await store.markNotificationRead(first.id, "reader-1");
  assert.equal(marked, true);
  assert.equal(await store.countUnreadNotifications("reader-1"), 1);

  const updatedCount = await store.markAllNotificationsRead("reader-1");
  assert.equal(updatedCount, 1);
  assert.equal(await store.countUnreadNotifications("reader-1"), 0);

  const notifications = await store.listNotifications("reader-1");
  assert.equal(notifications.length, 2);
  assert.ok(notifications.every((notification) => notification.readAt));
});

test("document aliases expose neutral corpus records without changing work storage", async () => {
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
      metadata: {
        rawKey: "gutenberg/raw/42/raw.txt",
      },
      cleanTextKey: "gutenberg/clean/42/clean.txt",
      chunksKey: "gutenberg/clean/42/chunks.jsonl",
      text: "First paragraph.\n\nSecond paragraph.",
    } as never,
  ], [
    {
      id: "chunk-1",
      workId: "work-1",
      chunkIndex: 0,
      text: "First paragraph.",
      excerpt: "First paragraph.",
      r2Key: "gutenberg/clean/42/chunks.jsonl",
    } as never,
  ]);

  const [documents, detail, files, textFile, chunks] = await Promise.all([
    store.searchDocuments("sample"),
    store.getDocumentById("work-1"),
    store.getDocumentFiles(["work-1"], ["clean", "chunks"]),
    store.getDocumentTextFile("work-1"),
    store.getRelevantDocumentChunks("paragraph", ["work-1"], 4),
  ]);

  assert.equal(documents[0]?.id, "work-1");
  assert.equal(documents[0]?.externalId, 42);
  assert.equal(detail?.title, "Sample Book");
  assert.deepEqual(detail?.contributors, ["Jane Doe"]);
  assert.equal(files.length, 2);
  assert.ok(files.every((file) => file.documentId === "work-1"));
  assert.deepEqual(textFile, {
    documentId: "work-1",
    r2Key: "gutenberg/clean/42/clean.txt",
  });
  assert.equal(chunks[0]?.documentId, "work-1");
});
