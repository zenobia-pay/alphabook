import test from "node:test";
import assert from "node:assert/strict";

import { deriveUserProgressCandidate, shouldIgnoreRawProgressText } from "../src/user-progress";

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

  assert.equal(candidate, null);
});

test("pretty cli file reads are rewritten at the task level", () => {
  const candidate = deriveUserProgressCandidate({
    event: "job.log",
    data: {
      text: "┊ 📄 read /srv/alphabook/gutenberg/research-corpus-index/all-text-files.tsv 0.1s",
    },
  });

  assert.deepEqual(candidate, {
    text: "Reviewing the corpus file index to choose search scope.",
    kind: "activity",
    meaningful: true,
  });
});

test("bounded ripgrep helper commands preserve the actual search terms", () => {
  const candidate = deriveUserProgressCandidate({
    event: "job.log",
    data: {
      text: `{"type":"item.completed","item":{"type":"command_execution","command":"/bin/bash -lc \\"/srv/alphabook/repo/ops/digitalocean/bin/run-ripgrep-progress.sh --file-list /tmp/part.tsv --pattern 'inventor|inventors|invention|invented' --output-dir /tmp/search\\""}}`,
    },
  });

  assert.deepEqual(candidate, {
    text: "Running a bounded corpus search for: inventor; inventors; invention; invented",
    kind: "activity",
    meaningful: true,
  });
});

test("workspace initialization scripts describe the actual setup work", () => {
  const candidate = deriveUserProgressCandidate({
    event: "job.log",
    data: {
      text: `{"type":"item.completed","item":{"type":"command_execution","command":"python3 - <<'PY'\\nwith open('manifest.json','w') as f: pass\\nwith open('run.log','a') as f: pass\\ncp /srv/alphabook/gutenberg/research-corpus-index/all-text-files.tsv /tmp/scoped-files.tsv\\nPY"}}`,
    },
  });

  assert.deepEqual(candidate, {
    text: "Initializing the search workspace, manifest, and scoped file list.",
    kind: "activity",
    meaningful: true,
  });
});

test("python heredoc search-pattern setup is summarized semantically", () => {
  const candidate = deriveUserProgressCandidate({
    event: "job.log",
    data: {
      text: `{"type":"item.completed","item":{"type":"command_execution","command":"python3 - <<'PY'\\npatterns=['memoir','autobiograph','biograph','obituary','for many years','collection','inventor','naturalist']\\nprint(patterns)\\nPY"}}`,
    },
  });

  assert.deepEqual(candidate, {
    text: "Preparing keyword search patterns for the corpus sweep.",
    kind: "activity",
    meaningful: true,
  });
});

test("python heredoc tsv normalization is summarized semantically", () => {
  const candidate = deriveUserProgressCandidate({
    event: "job.log",
    data: {
      text: `{"type":"item.completed","item":{"type":"command_execution","command":"python3 - <<'PY'\\ninput_path='scoped-files.tsv'\\noutput_path='scoped-files-clean.tsv'\\nPY"}}`,
    },
  });

  assert.deepEqual(candidate, {
    text: "Normalizing the scoped corpus file list before batched search.",
    kind: "activity",
    meaningful: true,
  });
});

test("run workspace tool start is suppressed in favor of the explicit search brief", () => {
  const candidate = deriveUserProgressCandidate({
    event: "tool.started",
    data: {
      toolName: "run_workspace_task",
      args: {
        taskSpec: {
          question: "Find real-life examples of obsessive preservers.",
        },
      },
    },
  });

  assert.equal(candidate, null);
});

test("partial hermes json command lines are still summarized", () => {
  const candidate = deriveUserProgressCandidate({
    event: "job.log",
    data: {
      text: "{\"type\":\"item.started\",\"item\":{\"id\":\"item_17\",\"type\":\"command_execution\",\"command\":\"/bin/bash -lc 'for spec in 56949:60:120 64761:38:95 68835:52:120; do echo $spec; done'\",\"aggregated_output\":\"\"}",
    },
  });

  assert.deepEqual(candidate, {
    text: "Sampling passages across the selected source volumes.",
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

test("timestamp-prefixed plain text lines are ignored unless explicitly structured", () => {
  const candidate = deriveUserProgressCandidate({
    event: "job.log",
    data: {
      text: "[2026-04-13T18:24:43Z] Wrote `final-answer.md` and `final-answer.json` in `/srv/alphabook/logs/codex-design-experiment/20260413T181730Z-886917d4`.",
    },
  });

  assert.equal(candidate, null);
});

test("long answer blobs are suppressed from progress logs", () => {
  const candidate = deriveUserProgressCandidate({
    event: "job.log",
    data: {
      text: "America and Ireland are the books to put under the lamp first. America looks built for immediate room response: the contents front-load short comic bits like “My Dog,” “Speech on the Babies,” and Bill Nye sketches, and the sampled opening starts joking almost before it has sat down. Ireland is different but equally alive: less vaudeville, more folk current, more social breath, more buoyancy and movement.",
    },
  });

  assert.equal(candidate, null);
});

test("raw launcher env lines are suppressed from progress logs", () => {
  const candidate = deriveUserProgressCandidate({
    event: "job.log",
    data: {
      text: "prompt_file=/srv/alphabook/logs/hermes-search/20260413T191411Z-794da1d0/state/prompt.txt",
    },
  });

  assert.equal(candidate, null);
});

test("generic launch chatter is excluded from cleanup candidates", () => {
  assert.equal(shouldIgnoreRawProgressText("Working through launching."), true);
  assert.equal(shouldIgnoreRawProgressText("Task heartbeat received: task is alive."), true);
  assert.equal(shouldIgnoreRawProgressText("Prepared the terminal."), true);
  assert.equal(shouldIgnoreRawProgressText("No user-meaningful activity captured."), true);
});

test("openai transport chatter is excluded from cleanup candidates", () => {
  assert.equal(shouldIgnoreRawProgressText("Sent a request to the OpenAI proxy to retrieve available models."), true);
  assert.equal(shouldIgnoreRawProgressText("Used model gpt-5.4."), true);
});

test("ripgrep helper reads are rewritten at the semantic level", () => {
  const candidate = deriveUserProgressCandidate({
    event: "job.log",
    data: {
      text: "┊ 📖 read /srv/alphabook/logs/corpus-search/20260413-180400-b97ef383/ripgrep-status.json 0.3s",
    },
  });

  assert.deepEqual(candidate, {
    text: "Checking whether the current bounded search batch is producing strong matches.",
    kind: "activity",
    meaningful: true,
  });
});

test("generic job progress launch detail is suppressed", () => {
  const candidate = deriveUserProgressCandidate({
    event: "job.progress",
    data: {
      detail: "Working through launching",
      phase: "launching",
    },
  });

  assert.equal(candidate, null);
});

test("failed partition processing is rewritten as a retry-oriented search failure", () => {
  const candidate = deriveUserProgressCandidate({
    event: "job.log",
    data: {
      text: "Processing failed for several .tsv parts across multiple steps (catalog, collect/preserve, craft/tinker, long years, meticulous, obsession).",
    },
  });

  assert.deepEqual(candidate, {
    text: "The first bounded search term groups failed across several TSV partitions; checking the failure output before retrying.",
    kind: "activity",
    meaningful: true,
  });
});

test("unknown raw shell blobs are suppressed instead of persisted", () => {
  const candidate = deriveUserProgressCandidate({
    event: "job.log",
    data: {
      text: "with open(os.path.join(run_dir,'manifest.json'),'w') as f: json.dump(manifest,f,indent=2)",
    },
  });

  assert.equal(candidate, null);
});

test("scoped file count lines are ignored unless emitted structurally", () => {
  const candidate = deriveUserProgressCandidate({
    event: "job.log",
    data: {
      text: "72644 /srv/alphabook/logs/corpus-search/20260413-191411-e2026b48/scoped-files.tsv",
    },
  });

  assert.equal(candidate, null);
});

test("partition file lines are ignored unless emitted structurally", () => {
  const candidate = deriveUserProgressCandidate({
    event: "job.log",
    data: {
      text: "PART /srv/alphabook/logs/corpus-search/20260413-191411-e2026b48/partitions/part-00001.files.tsv",
    },
  });

  assert.equal(candidate, null);
});
