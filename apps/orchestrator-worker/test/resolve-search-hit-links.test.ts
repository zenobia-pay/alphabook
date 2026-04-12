import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

test("resolve-search-hit-links enriches object-shaped hits indexes using hit markdown quotes", () => {
  const root = mkdtempSync(join(tmpdir(), "alphabook-hit-links-"));
  const innerRunDir = join(root, "run");
  const hitsDir = join(innerRunDir, "hits");
  const sourceDir = join(root, "gutenberg", "clean", "123");
  mkdirSync(hitsDir, { recursive: true });
  mkdirSync(sourceDir, { recursive: true });

  const sourceFile = join(sourceDir, "clean.txt");
  const chunksFile = join(sourceDir, "chunks.jsonl");
  const hitIndexFile = join(hitsDir, "index.json");
  const hitMarkdownFile = join(hitsDir, "hit-0001.md");

  writeFileSync(sourceFile, "placeholder\n", "utf8");
  writeFileSync(
    chunksFile,
    `${JSON.stringify({
      id: "chunk-123",
      work_id: "local-gutenberg-123",
      chunk_index: 7,
      reader_path: "/passages/apple-keepers",
      text: "Tom Brown spent decades preserving apples. He was indefatigable as a naturalist and preserved endangered varieties through field labor.",
    })}\n`,
    "utf8",
  );
  writeFileSync(
    hitIndexFile,
    `${JSON.stringify({
      hit_count: 1,
      hits: [
        {
          hit_id: "hit-0001",
          source_file: sourceFile,
          source_title: "Apple Keepers",
          source_author: "Jane Doe",
          matched_terms: ["indefatigable as a naturalist"],
          why_this_is_relevant: "Tracks obsessive preservation work.",
        },
      ],
    }, null, 2)}\n`,
    "utf8",
  );
  writeFileSync(
    hitMarkdownFile,
    [
      "hit_id: hit-0001",
      `source_file: ${sourceFile}`,
      "source_title: Apple Keepers",
      "source_author: Jane Doe",
      "matched_terms: [\"indefatigable as a naturalist\"]",
      "why_this_is_relevant: Tracks obsessive preservation work.",
      "",
      "exact_quoted_chunk:",
      "\"\"\"",
      "He was indefatigable as a naturalist and preserved endangered varieties through field labor.",
      "\"\"\"",
      "",
    ].join("\n"),
    "utf8",
  );

  const scriptPath = join(process.cwd(), "ops", "digitalocean", "bin", "resolve-search-hit-links.py");
  const output = execFileSync("python3", [
    scriptPath,
    "--inner-run-dir",
    innerRunDir,
    "--site-origin",
    "https://alpha-book.org",
  ], {
    cwd: process.cwd(),
    encoding: "utf8",
  });
  const result = JSON.parse(output);
  assert.equal(result.ok, true);
  assert.equal(result.hits_resolved, 1);

  const updatedIndex = JSON.parse(readFileSync(hitIndexFile, "utf8")) as {
    hit_count: number;
    hits: Array<Record<string, unknown>>;
  };
  assert.equal(updatedIndex.hit_count, 1);
  assert.equal(updatedIndex.hits[0]?.quote, "He was indefatigable as a naturalist and preserved endangered varieties through field labor.");
  assert.equal(updatedIndex.hits[0]?.reader_path, "/123/passages/apple-keepers");
  assert.equal(updatedIndex.hits[0]?.work_id, "local-gutenberg-123");
  assert.equal(
    updatedIndex.hits[0]?.alphabook_url,
    "https://alpha-book.org/?view=explore&reader=%2F123%2Fpassages%2Fapple-keepers&work=local-gutenberg-123",
  );

  const updatedHitMarkdown = readFileSync(hitMarkdownFile, "utf8");
  assert.match(updatedHitMarkdown, /^reader_path: \/123\/passages\/apple-keepers$/m);
  assert.match(updatedHitMarkdown, /^alphabook_url: https:\/\/alpha-book\.org\/\?view=explore&reader=%2F123%2Fpassages%2Fapple-keepers&work=local-gutenberg-123$/m);
  assert.match(updatedHitMarkdown, /^Exact quoted chunk:$/m);
});
