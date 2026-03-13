import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { generatedMirrorDirectory, htmlToText, listMirrorIds, mainMirrorDirectory, resolveMirrorSource } from "../src/mirror";

test("main mirror path matches Gutenberg digit hierarchy", () => {
  const root = "/srv/alphabook/gutenberg";
  assert.equal(mainMirrorDirectory(root, "3"), "/srv/alphabook/gutenberg/0/3");
  assert.equal(mainMirrorDirectory(root, "12345"), "/srv/alphabook/gutenberg/1/2/3/4/12345");
  assert.equal(generatedMirrorDirectory(root, "12345"), "/srv/alphabook/gutenberg/cache/epub/12345");
});

test("htmlToText strips simple markup", () => {
  const result = htmlToText("<html><body><h1>Hello</h1><p>World &amp; friends</p></body></html>");
  assert.match(result, /Hello/);
  assert.match(result, /World & friends/);
});

test("resolveMirrorSource prefers generated html and parses metadata", async () => {
  const root = await mkdtemp(join(tmpdir(), "alphabook-mirror-"));
  const generatedDir = generatedMirrorDirectory(root, "12345");
  await mkdir(generatedDir, { recursive: true });
  await writeFile(
    join(generatedDir, "pg12345.rdf"),
    `
      <dcterms:title>Mirror Title</dcterms:title>
      <pgterms:name>Jane Doe</pgterms:name>
      <dcterms:language><rdf:Description><rdf:value>en</rdf:value></rdf:Description></dcterms:language>
      <dcterms:subject><rdf:Description><rdf:value>Adventure stories</rdf:value></rdf:Description></dcterms:subject>
      <dcterms:issued>2026-03-13</dcterms:issued>
    `,
    "utf8",
  );
  await writeFile(join(generatedDir, "pg12345.txt"), "Sample mirrored text", "utf8");
  await writeFile(
    join(generatedDir, "pg12345-images.html"),
    '<html lang="en"><head><title>The Project Gutenberg eBook of Mirror Title, by Jane Doe</title></head><body><h1>Mirror Title</h1></body></html>',
    "utf8",
  );

  const result = await resolveMirrorSource(root, "12345");
  assert.equal(result.title, "Mirror Title");
  assert.equal(result.format, "html");
  assert.match(result.sourcePath, /pg12345-images\.html$/);
  assert.deepEqual(result.authors, ["Jane Doe"]);
  assert.deepEqual(result.subjects, ["Adventure stories"]);
  assert.equal(result.language, "en");
  assert.equal(result.releaseDate, "2026-03-13");
  assert.match(result.rawText, /Mirror Title/);
});

test("listMirrorIds reads generated epub directories", async () => {
  const root = await mkdtemp(join(tmpdir(), "alphabook-mirror-"));
  await mkdir(generatedMirrorDirectory(root, "12345"), { recursive: true });
  await mkdir(generatedMirrorDirectory(root, "54321"), { recursive: true });

  const ids = await listMirrorIds(root);
  assert.deepEqual(ids, ["12345", "54321"]);
});

test("listMirrorIds falls back to the main mirror tree", async () => {
  const root = await mkdtemp(join(tmpdir(), "alphabook-mirror-"));
  await mkdir(join(root, "0", "3"), { recursive: true });
  await mkdir(join(root, "1", "0", "0", "0", "1000"), { recursive: true });
  await writeFile(join(root, "0", "3", "3-0.txt"), "Three", "utf8");
  await writeFile(join(root, "1", "0", "0", "0", "1000", "1000-0.txt"), "Thousand", "utf8");

  const ids = await listMirrorIds(root);
  assert.deepEqual(ids, ["3", "1000"]);
});

test("resolveMirrorSource reads single-digit ids from the main mirror tree", async () => {
  const root = await mkdtemp(join(tmpdir(), "alphabook-mirror-"));
  await mkdir(join(root, "0", "3"), { recursive: true });
  await writeFile(join(root, "0", "3", "3-0.txt"), "Single digit text", "utf8");

  const result = await resolveMirrorSource(root, "3");
  assert.equal(result.format, "text");
  assert.match(result.sourcePath, /0\/3\/3-0\.txt$/);
  assert.equal(result.rawText, "Single digit text");
});
