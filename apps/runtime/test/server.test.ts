import test from "node:test";
import assert from "node:assert/strict";

import { createAlphaBookRuntimeServer } from "../src/server";

test("runtime server requires a shared auth token", () => {
  assert.throws(
    () => createAlphaBookRuntimeServer({ authToken: "" }),
    /RUNTIME_SHARED_TOKEN is required/,
  );
});

