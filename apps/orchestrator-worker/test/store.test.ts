import test from "node:test";
import assert from "node:assert/strict";

import type { DbClient } from "@alphabook/db";

import { InMemoryAppStore, SqlAppStore } from "../src/store";

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

test("appendRunEvent uses an atomic insert query for sequence allocation", async () => {
  const queries: Array<{ sql: string; params?: unknown[] }> = [];
  const db: DbClient = {
    async query<T = Record<string, unknown>>(sql: string, params?: unknown[]) {
      queries.push({ sql, params });
      if (
        sql.includes("CREATE TABLE IF NOT EXISTS run_events")
        || sql.includes("CREATE UNIQUE INDEX IF NOT EXISTS idx_run_events_run_id_sequence")
        || sql.includes("CREATE INDEX IF NOT EXISTS idx_run_events_run_id_created_at")
        || sql.startsWith("ALTER TABLE ")
      ) {
        return { rows: [] as T[] };
      }
      if (sql.includes("WITH run_lock AS")) {
        return { rows: [{ sequence: 7 }] as T[] };
      }
      throw new Error(`Unexpected query: ${sql}`);
    },
    async end() {},
  };
  const store = new SqlAppStore(db);

  const event = await store.appendRunEvent(
    "11111111-1111-1111-1111-111111111111",
    "22222222-2222-2222-2222-222222222222",
    "sprite.shard.started",
    { shardId: "books-1" },
  );

  assert.equal(event.sequence, 7);
  const insertQuery = queries.find((entry) => entry.sql.includes("WITH run_lock AS"));
  assert.ok(insertQuery);
  assert.match(insertQuery!.sql, /pg_advisory_xact_lock/);
  assert.match(insertQuery!.sql, /INSERT INTO run_events/);
  assert.equal(queries.filter((entry) => entry.sql.includes("INSERT INTO run_events")).length, 1);
});

test("appendRunEvent retries sequence conflicts from Postgres before failing", async () => {
  let attempts = 0;
  const db: DbClient = {
    async query<T = Record<string, unknown>>(sql: string) {
      if (
        sql.includes("CREATE TABLE IF NOT EXISTS run_events")
        || sql.includes("CREATE UNIQUE INDEX IF NOT EXISTS idx_run_events_run_id_sequence")
        || sql.includes("CREATE INDEX IF NOT EXISTS idx_run_events_run_id_created_at")
        || sql.startsWith("ALTER TABLE ")
      ) {
        return { rows: [] as T[] };
      }
      if (sql.includes("WITH run_lock AS")) {
        attempts += 1;
        if (attempts === 1) {
          const error = new Error('duplicate key value violates unique constraint "idx_run_events_run_id_sequence"') as Error & { code?: string };
          error.code = "23505";
          throw error;
        }
        return { rows: [{ sequence: 8 }] as T[] };
      }
      throw new Error(`Unexpected query: ${sql}`);
    },
    async end() {},
  };
  const store = new SqlAppStore(db);

  const event = await store.appendRunEvent(
    "11111111-1111-1111-1111-111111111111",
    "22222222-2222-2222-2222-222222222222",
    "sprite.shard.started",
    { shardId: "books-2" },
  );

  assert.equal(event.sequence, 8);
  assert.equal(attempts, 2);
});

test("in-memory store spills oversized run event payloads to blob storage and rehydrates them", async () => {
  const store = new InMemoryAppStore();
  const largeHtml = `<div>${"x".repeat(8_000)}</div>`;

  const written = await store.appendRunEvent(
    "run-1",
    "session-1",
    "tool.progress",
    {
      toolCallId: "tool-1",
      researchDocumentHtml: largeHtml,
      detail: {
        type: "research.chunk",
        chunkId: "chunk-1",
      },
    },
  );

  assert.ok(written.payloadRef);
  const events = await store.listRunEvents("run-1");
  assert.equal(events.length, 1);
  assert.equal(events[0]?.dataJson.researchDocumentHtml, largeHtml);
});

test("in-memory store stores runtime manifests by reference and still returns the full manifest", async () => {
  const store = new InMemoryAppStore();
  const manifest = {
    runtimeId: "runtime-1",
    sessionId: "session-1",
    documents: Array.from({ length: 20 }, (_, index) => ({
      documentId: `work-${index}`,
      title: `Work ${index}`,
    })),
    selectedChunkIds: ["chunk-a", "chunk-b"],
    fileCatalog: [{ r2Key: "books/work-1/clean.txt" }],
    taskContext: {
      researchMode: "sprite_fanout",
      shardId: "alpha",
      taskSpec: {
        mode: "sprite_fanout",
      },
    },
  };

  const saved = await store.saveRuntimeInstance({
    sessionId: "session-1",
    runtimeId: "runtime-1",
    provider: "fly",
    providerMachineId: null,
    status: "ready",
    manifestJson: manifest,
    lastUsedAt: null,
    expiresAt: null,
  });

  assert.ok(saved.manifestRef);
  assert.deepEqual(saved.selectedChunkIds, ["chunk-a", "chunk-b"]);
  const hydrated = await store.getRuntimeInstance("runtime-1");
  assert.ok(hydrated);
  assert.deepEqual(hydrated.manifestJson, manifest);
});
