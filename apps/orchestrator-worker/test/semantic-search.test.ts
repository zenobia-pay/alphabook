import test from "node:test";
import assert from "node:assert/strict";

import { resolveSemanticModelProvider } from "../src/semantic-search";

test("semantic search prefers OpenAI when both OpenAI and Google keys are configured", () => {
  const provider = resolveSemanticModelProvider({
    store: {} as never,
    embedder: {} as never,
    vectorIndex: {} as never,
    openAIApiKey: "openai-key",
    googleAIApiKey: "google-key",
  });

  assert.equal(provider, "openai");
});

test("semantic search falls back to Google only when OpenAI is unavailable", () => {
  const provider = resolveSemanticModelProvider({
    store: {} as never,
    embedder: {} as never,
    vectorIndex: {} as never,
    googleAIApiKey: "google-key",
  });

  assert.equal(provider, "google");
});
