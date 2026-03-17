import test from "node:test";
import assert from "node:assert/strict";

import { InMemoryAppStore } from "../src/store";

test("upsertUserProfile reuses the existing user when auth ids differ but email matches", async () => {
  const store = new InMemoryAppStore();

  const first = await store.upsertUserProfile({
    id: "staging-user-id",
    email: "reader@example.com",
    name: "Reader From Staging",
  });
  const second = await store.upsertUserProfile({
    id: "production-user-id",
    email: "reader@example.com",
    name: "Reader In Production",
  });

  assert.equal(first.id, "staging-user-id");
  assert.equal(second.id, "staging-user-id");

  const profile = await store.getUserProfile("staging-user-id");
  assert.ok(profile);
  assert.equal(profile.name, "Reader In Production");
  assert.equal(profile.email, "reader@example.com");
});
