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
