import { createHash } from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";

type ExistingWorkIdsPayload = Array<{
  results?: Array<{
    id?: string;
    gutenberg_id?: string | null;
  }>;
}>;

type PreparedBookManifest = {
  gutenbergId: string;
  d1Records?: {
    work?: {
      id?: string;
      gutenberg_id?: number | string;
      title?: string;
      language?: string | null;
      release_date?: string | null;
      rights_status?: string | null;
      summary?: string | null;
      metadata_json?: Record<string, unknown>;
    };
    workFiles?: Array<{
      kind: "raw" | "metadata" | "clean" | "chunks" | "book_html";
      r2_key: string;
    }>;
    authors?: string[];
    subjects?: string[];
  };
};

function sqliteLiteral(value: unknown): string {
  if (value === null || value === undefined) return "NULL";
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error(`Cannot serialize non-finite number ${value}`);
    return String(value);
  }
  if (typeof value === "boolean") return value ? "1" : "0";
  if (typeof value === "string") return `'${value.replace(/'/gu, "''")}'`;
  return sqliteLiteral(JSON.stringify(value));
}

function usage() {
  console.error(
    "Usage: tsx scripts/build-d1-corpus-import.ts <books-root> <canonical-ids-path> <output-dir> [existing-work-ids-json] [batch-size]",
  );
}

function stableId(prefix: string, value: string) {
  return `${prefix}-${createHash("sha1").update(value).digest("hex").slice(0, 24)}`;
}

async function readCanonicalIds(path: string) {
  const raw = await readFile(path, "utf8");
  return raw
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter((line) => /^\d+$/u.test(line))
    .map((line) => String(Number(line)));
}

async function readExistingWorkIds(path: string | null) {
  if (!path) return new Map<string, string>();
  const payload = JSON.parse(await readFile(path, "utf8")) as ExistingWorkIdsPayload;
  const rows = payload.flatMap((entry) => entry.results ?? []);
  return new Map(
    rows
      .filter((row): row is { id: string; gutenberg_id: string } => typeof row.id === "string" && typeof row.gutenberg_id === "string")
      .map((row) => [String(Number(row.gutenberg_id)), row.id]),
  );
}

async function readManifest(booksRoot: string, gutenbergId: string) {
  const path = join(booksRoot, gutenbergId, "manifest.json");
  return JSON.parse(await readFile(path, "utf8")) as PreparedBookManifest;
}

async function main() {
  const [booksRootArg, canonicalIdsPathArg, outputDirArg, existingWorkIdsPathArg, batchSizeArg] = process.argv.slice(2);
  if (!booksRootArg || !canonicalIdsPathArg || !outputDirArg) {
    usage();
    process.exit(1);
  }

  const booksRoot = resolve(process.cwd(), booksRootArg);
  const canonicalIdsPath = resolve(process.cwd(), canonicalIdsPathArg);
  const outputDir = resolve(process.cwd(), outputDirArg);
  const existingWorkIdsPath = existingWorkIdsPathArg ? resolve(process.cwd(), existingWorkIdsPathArg) : null;
  const batchSize = Math.max(1, Number(batchSizeArg ?? "1000"));
  const now = new Date().toISOString();

  const canonicalIds = await readCanonicalIds(canonicalIdsPath);
  const existingWorkIds = await readExistingWorkIds(existingWorkIdsPath);

  await rm(outputDir, { recursive: true, force: true });
  await mkdir(outputDir, { recursive: true });

  const resetSql = [
    "PRAGMA foreign_keys = ON;",
    "DELETE FROM work_subjects;",
    "DELETE FROM work_authors;",
    "DELETE FROM work_files;",
    "DELETE FROM subjects;",
    "DELETE FROM authors;",
    "DELETE FROM works;",
    "",
  ].join("\n");
  await writeFile(join(outputDir, "000-reset.sql"), resetSql, "utf8");

  let batchIndex = 1;
  let processedBooks = 0;
  let skippedBooks = 0;
  let insertedWorks = 0;
  let insertedWorkFiles = 0;
  let insertedAuthors = 0;
  let insertedSubjects = 0;
  const missingManifests: string[] = [];
  const batchFiles: string[] = [];

  for (let start = 0; start < canonicalIds.length; start += batchSize) {
    const ids = canonicalIds.slice(start, start + batchSize);
    const lines = ["PRAGMA foreign_keys = ON;"];

    for (const gutenbergId of ids) {
      let manifest: PreparedBookManifest;
      try {
        manifest = await readManifest(booksRoot, gutenbergId);
      } catch {
        skippedBooks += 1;
        missingManifests.push(gutenbergId);
        continue;
      }
      const work = manifest.d1Records?.work;
      if (!work) {
        skippedBooks += 1;
        missingManifests.push(gutenbergId);
        continue;
      }

      const workId = existingWorkIds.get(gutenbergId)
        ?? (typeof work.id === "string" && work.id.length > 0 ? work.id : `local-gutenberg-${gutenbergId}`);
      const metadataJson = work.metadata_json ?? {};
      const authors = Array.isArray(manifest.d1Records?.authors)
        ? manifest.d1Records!.authors.filter((value): value is string => typeof value === "string" && value.trim().length > 0)
        : [];
      const subjects = Array.isArray(manifest.d1Records?.subjects)
        ? manifest.d1Records!.subjects.filter((value): value is string => typeof value === "string" && value.trim().length > 0)
        : [];
      const workFiles = Array.isArray(manifest.d1Records?.workFiles) ? manifest.d1Records!.workFiles : [];

      lines.push(
        `INSERT INTO works (id, gutenberg_id, title, language, release_date, rights_status, summary, metadata_json, created_at, updated_at) VALUES (${[
          workId,
          Number(gutenbergId),
          work.title ?? `Project Gutenberg ${gutenbergId}`,
          work.language ?? null,
          work.release_date ?? null,
          work.rights_status ?? null,
          work.summary ?? null,
          JSON.stringify(metadataJson),
          now,
          now,
        ].map(sqliteLiteral).join(", ")});`,
      );
      insertedWorks += 1;

      for (const file of workFiles) {
        const workFileId = stableId("wf", `${gutenbergId}:${file.kind}:${file.r2_key}`);
        lines.push(
          `INSERT INTO work_files (id, work_id, kind, r2_key, metadata_json, created_at) VALUES (${[
            workFileId,
            workId,
            file.kind,
            file.r2_key,
            "{}",
            now,
          ].map(sqliteLiteral).join(", ")});`,
        );
        insertedWorkFiles += 1;
      }

      for (const author of authors) {
        const authorId = stableId("author", author.toLowerCase());
        lines.push(
          `INSERT OR IGNORE INTO authors (id, name, sort_name, created_at) VALUES (${[
            authorId,
            author,
            author,
            now,
          ].map(sqliteLiteral).join(", ")});`,
        );
        lines.push(
          `INSERT OR IGNORE INTO work_authors (work_id, author_id) VALUES (${[
            workId,
            authorId,
          ].map(sqliteLiteral).join(", ")});`,
        );
        insertedAuthors += 1;
      }

      for (const subject of subjects) {
        const subjectId = stableId("subject", subject);
        lines.push(
          `INSERT OR IGNORE INTO subjects (id, label) VALUES (${[
            subjectId,
            subject,
          ].map(sqliteLiteral).join(", ")});`,
        );
        lines.push(
          `INSERT OR IGNORE INTO work_subjects (work_id, subject_id) VALUES (${[
            workId,
            subjectId,
          ].map(sqliteLiteral).join(", ")});`,
        );
        insertedSubjects += 1;
      }

      processedBooks += 1;
    }

    lines.push("");
    const fileName = `${String(batchIndex).padStart(3, "0")}-corpus.sql`;
    await writeFile(join(outputDir, fileName), lines.join("\n"), "utf8");
    batchFiles.push(fileName);
    batchIndex += 1;
  }

  await writeFile(
    join(outputDir, "manifest.json"),
    `${JSON.stringify({
      generatedAt: now,
      booksRoot,
      canonicalIdsPath,
      existingWorkIdsPath,
      batchSize,
      canonicalIdCount: canonicalIds.length,
      processedBooks,
      skippedBooks,
      insertedWorks,
      insertedWorkFiles,
      insertedAuthors,
      insertedSubjects,
      missingManifests,
      files: ["000-reset.sql", ...batchFiles],
    }, null, 2)}\n`,
    "utf8",
  );
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack ?? error.message : String(error));
  process.exit(1);
});
