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
