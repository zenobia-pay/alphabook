import test from "node:test";
import assert from "node:assert/strict";

import { deriveUserProgressCandidate } from "../src/user-progress";

test("tool.started preserves concrete search query text", () => {
  const candidate = deriveUserProgressCandidate({
    event: "tool.started",
    data: {
      toolName: "semantic_deep_search",
      args: {
        query: "grief as moral purification in 19th century fiction",
      },
    },
  });

  assert.deepEqual(candidate, {
    text: "Searching passages for: grief as moral purification in 19th century fiction",
    kind: "activity",
    meaningful: true,
  });
});

test("job.log command execution becomes a readable search update with terms", () => {
  const candidate = deriveUserProgressCandidate({
    event: "job.log",
    data: {
      text: JSON.stringify({
        type: "item.started",
        item: {
          id: "item_58",
          type: "command_execution",
          command: "/bin/bash -lc \"rg -n 'Farmer Gerrit|Hair-dresser|A Dutch Podsnap|The Candidate' /mnt/alphabook_consolidation/final/20260402T044501Z/r2/gutenberg/clean/64761/clean.txt | head -n 40\"",
        },
      }),
    },
  });

  assert.deepEqual(candidate, {
    text: "Searching source volume 64761 for: Farmer Gerrit; Hair-dresser; A Dutch Podsnap; The Candidate",
    kind: "activity",
    meaningful: true,
  });
});

test("heartbeat lines become task-oriented liveness updates", () => {
  const candidate = deriveUserProgressCandidate({
    event: "job.log",
    data: {
      text: "2026-04-13T17:35:38Z pid=2732595 alive",
      detail: {
        source: "heartbeat",
      },
    },
    lastMeaningfulText: "Comparing candidate joke patterns across five country books.",
  });

  assert.deepEqual(candidate, {
    text: "Still working: Comparing candidate joke patterns across five country books.",
    kind: "heartbeat",
    meaningful: false,
  });
});

test("launch prompt lines are rewritten as explicit user-facing briefs", () => {
  const candidate = deriveUserProgressCandidate({
    event: "tool.progress",
    data: {
      text: "Launching agentic search with user query 'Find people who became experts through obsessive niche preservation work'",
    },
  });

  assert.deepEqual(candidate, {
    text: "Search brief: Find people who became experts through obsessive niche preservation work",
    kind: "status",
    meaningful: true,
  });
});

test("pretty cli helper lines are normalized into readable activity", () => {
  const candidate = deriveUserProgressCandidate({
    event: "job.log",
    data: {
      text: "┊ 📖 read /srv/alphabook/logs/corpus-search/20260413-180400-b97ef383/run.log 0.9s",
    },
  });

  assert.deepEqual(candidate, {
    text: "Reading the current run log.",
    kind: "activity",
    meaningful: true,
  });
});

test("json fragments from manifest dumps are suppressed", () => {
  const candidate = deriveUserProgressCandidate({
    event: "job.log",
    data: {
      text: "\"path\": \"/srv/alphabook/logs/codex-design-experiment/manifest.json\",",
    },
  });

  assert.equal(candidate, null);
});
