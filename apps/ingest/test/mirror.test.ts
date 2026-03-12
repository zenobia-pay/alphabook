import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { generatedMirrorDirectory, htmlToText, listMirrorIds, mainMirrorDirectory, resolveMirrorSource } from "../src/mirror";

test("main mirror path matches Gutenberg digit hierarchy", () => {
  const root = "/srv/alphabook/gutenberg";
  assert.equal(mainMirrorDirectory(root, "12345"), "/srv/alphabook/gutenberg/1/2/3/4/12345");
  assert.equal(generatedMirrorDirectory(root, "12345"), "/srv/alphabook/gutenberg/cache/epub/12345");
});

test("htmlToText strips simple markup", () => {
  const result = htmlToText("<html><body><h1>Hello</h1><p>World &amp; friends</p></body></html>");
  assert.match(result, /Hello/);
  assert.match(result, /World & friends/);
});

test("resolveMirrorSource prefers generated text and parses rdf title", async () => {
  const root = await mkdtemp(join(tmpdir(), "alphabook-mirror-"));
  const generatedDir = generatedMirrorDirectory(root, "12345");
  await mkdir(generatedDir, { recursive: true });
  await writeFile(join(generatedDir, "pg12345.rdf"), "<dcterms:title>Mirror Title</dcterms:title>", "utf8");
  await writeFile(join(generatedDir, "pg12345.txt"), "Sample mirrored text", "utf8");

  const result = await resolveMirrorSource(root, "12345");
  assert.equal(result.title, "Mirror Title");
  assert.equal(result.format, "text");
  assert.match(result.sourcePath, /pg12345\.txt$/);
  assert.equal(result.rawText, "Sample mirrored text");
});

test("listMirrorIds reads generated epub directories", async () => {
  const root = await mkdtemp(join(tmpdir(), "alphabook-mirror-"));
  await mkdir(generatedMirrorDirectory(root, "12345"), { recursive: true });
  await mkdir(generatedMirrorDirectory(root, "54321"), { recursive: true });

  const ids = await listMirrorIds(root);
  assert.deepEqual(ids, ["12345", "54321"]);
});
