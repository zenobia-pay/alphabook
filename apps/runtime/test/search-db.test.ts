import test from "node:test";
import assert from "node:assert/strict";

import { globToRegex, parseArgs } from "../bin/search-db.mjs";

test("parseArgs supports glob, kind, multiline, and window flags", () => {
  const args = parseArgs([
    "rg",
    "-i",
    "-U",
    "--window",
    "3",
    "--glob",
    "gutenberg/clean/**/clean.txt",
    "--kind",
    "clean_text",
    "--kind",
    "chunks",
    "anger|wrath",
  ]);

  assert.equal(args.ignoreCase, true);
  assert.equal(args.multiline, true);
  assert.equal(args.window, 3);
  assert.deepEqual(args.globs, ["gutenberg/clean/**/clean.txt"]);
  assert.deepEqual(args.kinds, ["clean", "chunks"]);
  assert.deepEqual(args._, ["rg", "anger|wrath"]);
});

test("multiline implies a non-zero window", () => {
  const args = parseArgs(["rg", "-U", "anger\\nwrath"]);
  assert.equal(args.multiline, true);
  assert.equal(args.window, 1);
});

test("parseArgs supports work-search date filters", () => {
  const args = parseArgs([
    "works",
    "--query",
    "grief mourning fiction",
    "--language",
    "en",
    "--year-from",
    "1800",
    "--year-to",
    "1899",
  ]);

  assert.equal(args.query, "grief mourning fiction");
  assert.equal(args.language, "en");
  assert.equal(args.yearFrom, 1800);
  assert.equal(args.yearTo, 1899);
});

test("globToRegex handles single and double star wildcards", () => {
  const regex = new RegExp(globToRegex("gutenberg/clean/**/clean.txt"));
  assert.equal(regex.test("gutenberg/clean/9/clean.txt"), true);
  assert.equal(regex.test("gutenberg/clean/123/segments/clean.txt"), true);
  assert.equal(regex.test("gutenberg/raw/9/raw.txt"), false);

  const single = new RegExp(globToRegex("gutenberg/clean/*/clean.txt"));
  assert.equal(single.test("gutenberg/clean/9/clean.txt"), true);
  assert.equal(single.test("gutenberg/clean/123/segments/clean.txt"), false);
});
