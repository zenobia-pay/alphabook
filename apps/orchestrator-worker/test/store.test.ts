import test from "node:test";
import assert from "node:assert/strict";

import type { DbClient } from "@alphabook/db";

import { SqlAppStore } from "../src/sql-store";
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

test("appendRunEvent persists the allocated sequence into run_events", async () => {
  const queries: Array<{ sql: string; params?: unknown[] }> = [];
  const db: DbClient = {
    async query<T = Record<string, unknown>>(sql: string, params?: unknown[]) {
      queries.push({ sql, params });
      if (
        sql.includes("CREATE TABLE IF NOT EXISTS run_events")
        || sql.includes("CREATE TABLE IF NOT EXISTS run_event_sequences")
        || sql.includes("CREATE UNIQUE INDEX IF NOT EXISTS idx_run_events_run_id_sequence")
        || sql.includes("CREATE INDEX IF NOT EXISTS idx_run_events_run_id_created_at")
        || sql.startsWith("ALTER TABLE ")
      ) {
        return { rows: [] as T[] };
      }
      if (sql.includes("INSERT INTO run_event_sequences")) {
        return { rows: [{ next_sequence: 7 }] as T[] };
      }
      if (sql.includes("INSERT INTO run_events")) {
        return { rows: [] as T[] };
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
  const sequenceQuery = queries.find((entry) => entry.sql.includes("INSERT INTO run_event_sequences"));
  assert.ok(sequenceQuery);
  const insertQuery = queries.find((entry) => entry.sql.includes("INSERT INTO run_events"));
  assert.ok(insertQuery);
  assert.match(insertQuery!.sql, /VALUES \(\?, \?, \?, \?, \?, \?, \?, \?, \?, \?, \?, \?, \?, \?\)/);
  assert.equal(queries.filter((entry) => entry.sql.includes("INSERT INTO run_events")).length, 1);
});

test("appendRunEvent allocates sequence numbers from the dedicated counter table", async () => {
  let sequenceAllocations = 0;
  const db: DbClient = {
    async query<T = Record<string, unknown>>(sql: string, params?: unknown[]) {
      if (
        sql.includes("CREATE TABLE IF NOT EXISTS run_events")
        || sql.includes("CREATE TABLE IF NOT EXISTS run_event_sequences")
        || sql.includes("CREATE UNIQUE INDEX IF NOT EXISTS idx_run_events_run_id_sequence")
        || sql.includes("CREATE INDEX IF NOT EXISTS idx_run_events_run_id_created_at")
        || sql.startsWith("ALTER TABLE ")
      ) {
        return { rows: [] as T[] };
      }
      if (sql.includes("INSERT INTO run_event_sequences")) {
        sequenceAllocations += 1;
        return { rows: [{ next_sequence: 8 }] as T[] };
      }
      if (sql.includes("INSERT INTO run_events")) {
        return { rows: [] as T[] };
      }
      throw new Error(`Unexpected query: ${sql} :: ${JSON.stringify(params ?? [])}`);
    },
    async end() {},
  };

  const store = new SqlAppStore(db);
  const event = await store.appendRunEvent(
    "11111111-1111-1111-1111-111111111111",
    "22222222-2222-2222-2222-222222222222",
    "run.progress",
    { status: "running" },
  );

  assert.equal(sequenceAllocations, 1);
  assert.equal(event.sequence, 8);
});

test("SQL store serves explore works from feed snapshots without hydrating the full corpus", async () => {
  const queries: Array<{ sql: string; params?: unknown[] }> = [];
  const db: DbClient = {
    async query<T = Record<string, unknown>>(sql: string, params?: unknown[]) {
      queries.push({ sql, params });
      if (sql.includes("FROM feed_works")) {
        return {
          rows: [{
            work_id: "work-1",
            gutenberg_id: 42,
            title: "Sample Book: A Tale",
            language: "en",
            release_date: "1900-01-01",
            rights_status: "public_domain",
            summary: "Sample summary",
            metadata_json: JSON.stringify({
              coverImageUrl: "https://example.com/cover.jpg",
              publisher: "Example Press",
              bookshelves: ["Fiction"],
            }),
            authors_json: JSON.stringify(["Jane Doe"]),
            subjects_json: JSON.stringify(["Testing"]),
            score: 2.23,
            feed_label: "Worth opening",
          }] as T[],
        };
      }
      if (sql.includes("COUNT(*) AS count")) {
        return { rows: [{ count: "33328" }] as T[] };
      }
      if (sql.includes("FROM site_stats")) {
        return { rows: [] as T[] };
      }
      if (sql.includes("FROM works ORDER BY title ASC") || sql.includes("FROM work_authors") || sql.includes("FROM work_subjects")) {
        throw new Error(`Unexpected corpus hydration query: ${sql}`);
      }
      throw new Error(`Unexpected query: ${sql}`);
    },
    async end() {},
  };

  const store = new SqlAppStore(db);
  const [works, count] = await Promise.all([
    store.listWorks(0, 12),
    store.countWorks(),
  ]);

  assert.equal(works.length, 1);
  assert.equal(works[0]?.id, "work-1");
  assert.equal(works[0]?.title, "Sample Book: A Tale");
  assert.equal(works[0]?.subtitle, null);
  assert.deepEqual(works[0]?.authors, ["Jane Doe"]);
  assert.deepEqual(works[0]?.bookshelves, ["Fiction"]);
  assert.equal(works[0]?.feedLabel, "Worth opening");
  assert.equal(count, 33328);
  assert.ok(queries.some((entry) => entry.sql.includes("FROM feed_works")));
  assert.ok(queries.some((entry) => entry.sql.includes("COUNT(*) AS count")));
});

test("SQL store admin rollups use persisted sessions, messages, tool calls, billing, and analytics data", async () => {
  const db: DbClient = {
    async query<T = Record<string, unknown>>(sql: string) {
      if (sql.startsWith("ALTER TABLE runs ADD COLUMN ")) {
        return { rows: [] as T[] };
      }
      if (sql === "SELECT id, email, name, avatar_url, created_at FROM users ORDER BY created_at DESC") {
        return {
          rows: [
            {
              id: "user-1",
              email: "reader@example.com",
              name: "Reader",
              avatar_url: null,
              created_at: "2026-03-01T00:00:00.000Z",
            },
          ] as T[],
        };
      }
      if (sql === "SELECT follower_id, followed_id FROM user_follows") {
        return { rows: [] as T[] };
      }
      if (sql === "SELECT id, user_id, created_at FROM chat_sessions") {
        return {
          rows: [
            { id: "session-1", user_id: "user-1", created_at: "2026-03-20T09:00:00.000Z" },
            { id: "session-2", user_id: "user-1", created_at: "2026-04-07T09:00:00.000Z" },
          ] as T[],
        };
      }
      if (sql === "SELECT session_id, started_at, completed_at FROM runs") {
        return {
          rows: [
            { session_id: "session-1", started_at: "2026-03-20T09:05:00.000Z", completed_at: "2026-03-20T09:06:00.000Z" },
            { session_id: "session-2", started_at: "2026-04-07T09:05:00.000Z", completed_at: null },
          ] as T[],
        };
      }
      if (sql === "SELECT session_id, created_at FROM messages") {
        return {
          rows: [
            { session_id: "session-1", created_at: "2026-03-20T09:01:00.000Z" },
            { session_id: "session-2", created_at: "2026-04-07T12:00:00.000Z" },
          ] as T[],
        };
      }
      if (sql === "SELECT user_id, session_id, cost_usd, created_at FROM billing_events") {
        return {
          rows: [
            { user_id: "user-1", session_id: "session-1", cost_usd: 1, created_at: "2026-02-15T09:06:00.000Z" },
            { user_id: "user-1", session_id: "session-1", cost_usd: 1.25, created_at: "2026-03-20T09:06:00.000Z" },
            { user_id: null, session_id: "session-2", cost_usd: 2.5, created_at: "2026-04-07T10:00:00.000Z" },
          ] as T[],
        };
      }
      if (sql === "SELECT user_id, session_id, created_at FROM analytics_events") {
        return {
          rows: [
            { user_id: null, session_id: "session-2", created_at: "2026-04-07T13:00:00.000Z" },
          ] as T[],
        };
      }
      if (sql === "SELECT id, user_id, title, created_at FROM chat_sessions ORDER BY created_at DESC") {
        return {
          rows: [
            { id: "session-2", user_id: "user-1", title: "Recent session", created_at: "2026-04-07T09:00:00.000Z" },
            { id: "session-1", user_id: "user-1", title: "Older session", created_at: "2026-03-20T09:00:00.000Z" },
          ] as T[],
        };
      }
      if (sql === "SELECT session_id FROM runs") {
        return {
          rows: [
            { session_id: "session-1" },
            { session_id: "session-2" },
          ] as T[],
        };
      }
      if (sql === "SELECT session_id, content, created_at FROM messages") {
        return {
          rows: [
            { session_id: "session-1", content: "First question", created_at: "2026-03-20T09:01:00.000Z" },
            { session_id: "session-1", content: "Older answer", created_at: "2026-03-20T09:02:00.000Z" },
            { session_id: "session-2", content: "Recent question", created_at: "2026-04-07T12:00:00.000Z" },
          ] as T[],
        };
      }
      if (sql === "SELECT session_id, cost_usd FROM billing_events") {
        return {
          rows: [
            { session_id: "session-1", cost_usd: 1.25 },
            { session_id: "session-2", cost_usd: 2.5 },
          ] as T[],
        };
      }
      if (sql.includes("SELECT id, session_id, status, started_at, completed_at, planner_turns, owner_instance_id, heartbeat_at, lease_expires_at, active_tool_call_id FROM runs ORDER BY started_at DESC")) {
        return {
          rows: [
            {
              id: "run-2",
              session_id: "session-2",
              status: "running",
              started_at: "2026-04-07T09:05:00.000Z",
              completed_at: null,
              planner_turns: 1,
              owner_instance_id: null,
              heartbeat_at: null,
              lease_expires_at: null,
              active_tool_call_id: null,
            },
            {
              id: "run-1",
              session_id: "session-1",
              status: "completed",
              started_at: "2026-03-20T09:05:00.000Z",
              completed_at: "2026-03-20T09:06:00.000Z",
              planner_turns: 2,
              owner_instance_id: null,
              heartbeat_at: null,
              lease_expires_at: null,
              active_tool_call_id: null,
            },
          ] as T[],
        };
      }
      if (sql === "SELECT id, user_id, title FROM chat_sessions") {
        return {
          rows: [
            { id: "session-1", user_id: "user-1", title: "Older session" },
            { id: "session-2", user_id: "user-1", title: "Recent session" },
          ] as T[],
        };
      }
      if (sql === "SELECT run_id FROM tool_calls") {
        return {
          rows: [
            { run_id: "run-1" },
            { run_id: "run-1" },
            { run_id: "run-2" },
          ] as T[],
        };
      }
      if (sql === "SELECT run_id, cost_usd FROM billing_events") {
        return {
          rows: [
            { run_id: "run-1", cost_usd: 1.25 },
            { run_id: "run-2", cost_usd: 2.5 },
          ] as T[],
        };
      }
      throw new Error(`Unexpected query: ${sql}`);
    },
    async end() {},
  };

  const store = new SqlAppStore(db);
  const [users, sessions, runs] = await Promise.all([
    store.listUsers(),
    store.listAdminSessions(),
    store.listAllRuns(),
  ]);

  assert.equal(users.length, 1);
  assert.equal(users[0]?.sessionCount, 2);
  assert.equal(users[0]?.runCount, 2);
  assert.equal(users[0]?.monthlySpendUsd, 3.75);
  assert.equal(users[0]?.totalSpendUsd, 4.75);
  assert.equal(users[0]?.billingEventCount, 3);
  assert.equal(users[0]?.lastSeenAt, "2026-04-07T13:00:00.000Z");

  assert.equal(sessions.length, 2);
  assert.equal(sessions[0]?.id, "session-2");
  assert.equal(sessions[0]?.runCount, 1);
  assert.equal(sessions[0]?.messageCount, 1);
  assert.equal(sessions[0]?.lastMessagePreview, "Recent question");
  assert.equal(sessions[0]?.spendUsd, 2.5);
  assert.equal(sessions[1]?.messageCount, 2);
  assert.equal(sessions[1]?.spendUsd, 1.25);

  assert.equal(runs.length, 2);
  assert.equal(runs[0]?.id, "run-2");
  assert.equal(runs[0]?.toolCallCount, 1);
  assert.equal(runs[0]?.messageCount, 1);
  assert.equal(runs[0]?.lastMessagePreview, "Recent question");
  assert.equal(runs[0]?.spendUsd, 2.5);
  assert.equal(runs[1]?.toolCallCount, 2);
  assert.equal(runs[1]?.messageCount, 2);
  assert.equal(runs[1]?.spendUsd, 1.25);
});

test("SQL store resolves single-work detail and files without hydrating the full corpus", async () => {
  const queries: Array<{ sql: string; params?: unknown[] }> = [];
  const db: DbClient = {
    async query<T = Record<string, unknown>>(sql: string, params?: unknown[]) {
      queries.push({ sql, params });
      if (sql.includes("FROM works w") && sql.includes("WHERE w.id = ?")) {
        return {
          rows: [{
            id: "work-1",
            gutenberg_id: 42,
            title: "Sample Book: A Tale",
            language: "en",
            release_date: "1900-01-01",
            rights_status: "public_domain",
            summary: "Sample summary",
            metadata_json: JSON.stringify({
              coverImageKey: "gutenberg/raw/42/cover.jpg",
              publisher: "Example Press",
              bookshelves: ["Fiction"],
            }),
            authors_json: JSON.stringify(["Jane Doe"]),
            subjects_json: JSON.stringify(["Testing"]),
          }] as T[],
        };
      }
      if (sql.includes("FROM work_files wf")) {
        return {
          rows: [{
            id: "file-1",
            work_id: "work-1",
            kind: "book_html",
            r2_key: "gutenberg/clean/42/book.html",
            byte_size: 1234,
            metadata_json: JSON.stringify({}),
            created_at: "2026-04-07T00:00:00.000Z",
          }] as T[],
        };
      }
      if (sql.includes("FROM works ORDER BY title ASC") || sql.includes("FROM work_authors") || sql.includes("FROM work_subjects")) {
        throw new Error(`Unexpected corpus hydration query: ${sql}`);
      }
      throw new Error(`Unexpected query: ${sql}`);
    },
    async end() {},
  };

  const store = new SqlAppStore(db);
  const [work, document, files] = await Promise.all([
    store.getWorkById("work-1"),
    store.getDocumentById("work-1"),
    store.getWorkFiles(["work-1"], ["book_html"]),
  ]);

  assert.equal(work?.id, "work-1");
  assert.equal(work?.title, "Sample Book: A Tale");
  assert.equal(work?.subtitle, null);
  assert.deepEqual(work?.authors, ["Jane Doe"]);
  assert.equal(document?.id, "work-1");
  assert.equal(document?.externalId, 42);
  assert.equal(files[0]?.id, "file-1");
  assert.equal(files[0]?.r2Key, "gutenberg/clean/42/book.html");
  assert.ok(queries.some((entry) => entry.sql.includes("WHERE w.id = ?")));
  assert.ok(queries.some((entry) => entry.sql.includes("FROM work_files wf")));
});

test("SQL store hydrates chunks by id without preloading the full corpus", async () => {
  const queries: Array<{ sql: string; params?: unknown[] }> = [];
  const db: DbClient = {
    async query<T = Record<string, unknown>>(sql: string, params?: unknown[]) {
      queries.push({ sql, params });
      if (sql.includes("SELECT id FROM works WHERE gutenberg_id = ?")) {
        return { rows: [{ id: "work-1" }] as T[] };
      }
      if (sql.includes("SELECT id, gutenberg_id, title, metadata_json FROM works WHERE id = ?")) {
        return {
          rows: [{
            id: "work-1",
            gutenberg_id: 42,
            title: "Sample Diary",
            metadata_json: JSON.stringify({ corpusAdapterId: "gutenberg", externalId: "42" }),
          }] as T[],
        };
      }
      if (sql.includes("SELECT a.name FROM work_authors")) {
        return { rows: [{ name: "Jane Doe" }] as T[] };
      }
      if (sql.includes("SELECT kind, r2_key FROM work_files WHERE work_id = ?")) {
        return {
          rows: [{
            kind: "chunks",
            r2_key: "gutenberg/chunks/42/chunks.jsonl",
          }] as T[],
        };
      }
      if (sql.includes("FROM works ORDER BY title ASC") || sql.includes("FROM work_subjects")) {
        throw new Error(`Unexpected corpus hydration query: ${sql}`);
      }
      throw new Error(`Unexpected query: ${sql}`);
    },
    async end() {},
  };

  const blobStore = {
    async getText(key: string) {
      assert.equal(key, "gutenberg/chunks/42/chunks.jsonl");
      return [
        JSON.stringify({
          id: "gutenberg:42:0",
          chunk_index: 0,
          text: "Dear diary, today was interesting.",
          excerpt: "Dear diary, today was interesting.",
          authors: ["Jane Doe"],
        }),
      ].join("\n");
    },
    async putText() {
      throw new Error("Unexpected putText");
    },
    async getJson() {
      return null;
    },
    async putJson() {
      throw new Error("Unexpected putJson");
    },
    async delete() {
      throw new Error("Unexpected delete");
    },
  };

  const store = new SqlAppStore(db, { blobStore: blobStore as never });
  const chunks = await store.getChunksByIds(["gutenberg:42:0"]);

  assert.equal(chunks.length, 1);
  assert.equal(chunks[0]?.workId, "work-1");
  assert.equal(chunks[0]?.workTitle, "Sample Diary");
  assert.deepEqual(chunks[0]?.authors, ["Jane Doe"]);
  assert.equal(chunks[0]?.r2Key, "gutenberg/chunks/42/chunks.jsonl");
  assert.ok(queries.some((entry) => entry.sql.includes("SELECT id FROM works WHERE gutenberg_id = ?")));
  assert.ok(!queries.some((entry) => entry.sql.includes("FROM works ORDER BY title ASC")));
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

test("research tasks support checkpoint updates", async () => {
  const store = new InMemoryAppStore();

  const task = await store.createResearchTask({
    runId: "run-1",
    sessionId: "session-1",
    toolCallId: "tool-1",
    kind: "semantic_research",
    taskSpecJson: { query: "grief and revenge" },
  });

  assert.equal(task.status, "queued");

  await store.updateResearchTask(task.id, {
    status: "running",
    progressSeq: 3,
    checkpointJson: {
      type: "semantic.alphaloop",
      step: "rerank",
    },
  });

  const latest = await store.getLatestResearchTaskForToolCall("tool-1");
  assert.ok(latest);
  assert.equal(latest.status, "running");
  assert.equal(latest.progressSeq, 3);
  assert.deepEqual(latest.checkpointJson, {
    type: "semantic.alphaloop",
    step: "rerank",
  });

  const runTasks = await store.listResearchTasksForRun("run-1");
  assert.equal(runTasks.length, 1);
  assert.equal(runTasks[0]?.status, "running");
});
