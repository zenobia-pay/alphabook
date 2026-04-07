import { readdir, readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import process from "node:process";

import { Pool } from "pg";

type ManifestWorkRecord = {
  id: string;
  gutenberg_id: number | null;
  title: string;
  language: string | null;
  release_date: string | null;
  rights_status: string | null;
  summary: string | null;
  metadata_json: Record<string, unknown>;
};

type ManifestWorkFileRecord = {
  kind: "raw" | "metadata" | "clean" | "chunks" | "book_html";
  r2_key: string;
};

type BookManifest = {
  gutenbergId: string;
  title: string;
  d1Records?: {
    work: ManifestWorkRecord;
    workFiles?: ManifestWorkFileRecord[];
    authors?: string[];
    subjects?: string[];
  };
};

function uniqueStrings(values: string[] | undefined) {
  return Array.from(new Set((values ?? []).map((value) => value.trim()).filter(Boolean)));
}

async function listManifestPaths(booksRoot: string) {
  const entries = await readdir(booksRoot, { withFileTypes: true });
  return entries
    .filter((entry) => entry.isDirectory())
    .map((entry) => join(booksRoot, entry.name, "manifest.json"));
}

async function parseManifest(path: string): Promise<BookManifest | null> {
  try {
    return JSON.parse(await readFile(path, "utf8")) as BookManifest;
  } catch {
    return null;
  }
}

async function ensureAuthor(pool: Pool, authorName: string) {
  const existing = await pool.query<{ id: string }>(
    `SELECT id FROM authors WHERE lower(name) = lower($1) LIMIT 1`,
    [authorName],
  );
  const authorId = existing.rows[0]?.id ?? crypto.randomUUID();
  if (!existing.rows[0]?.id) {
    await pool.query(
      `INSERT INTO authors (id, name, sort_name, created_at) VALUES ($1, $2, $3, CURRENT_TIMESTAMP)`,
      [authorId, authorName, authorName],
    );
  }
  return authorId;
}

async function ensureSubject(pool: Pool, subjectLabel: string) {
  const existing = await pool.query<{ id: string }>(
    `SELECT id FROM subjects WHERE label = $1 LIMIT 1`,
    [subjectLabel],
  );
  const subjectId = existing.rows[0]?.id ?? crypto.randomUUID();
  if (!existing.rows[0]?.id) {
    await pool.query(
      `INSERT INTO subjects (id, label) VALUES ($1, $2) ON CONFLICT (label) DO NOTHING`,
      [subjectId, subjectLabel],
    );
  }
  const resolved = existing.rows[0]?.id
    ? subjectId
    : (
        await pool.query<{ id: string }>(`SELECT id FROM subjects WHERE label = $1 LIMIT 1`, [subjectLabel])
      ).rows[0]?.id;
  if (!resolved) {
    throw new Error(`Failed to resolve subject ${subjectLabel}`);
  }
  return resolved;
}

type ImportState = {
  authorIdsByLowerName: Map<string, string>;
  subjectIdsByLabel: Map<string, string>;
};

type NormalizedManifest = {
  work: ManifestWorkRecord;
  workFiles: Array<{ id: string; work_id: string; kind: ManifestWorkFileRecord["kind"]; r2_key: string }>;
  authorNames: string[];
  subjectLabels: string[];
};

async function loadImportState(pool: Pool): Promise<ImportState> {
  const [authorsResult, subjectsResult] = await Promise.all([
    pool.query<{ id: string; name: string }>(`SELECT id, name FROM authors`),
    pool.query<{ id: string; label: string }>(`SELECT id, label FROM subjects`),
  ]);
  return {
    authorIdsByLowerName: new Map(authorsResult.rows.map((row) => [row.name.toLowerCase(), row.id])),
    subjectIdsByLabel: new Map(subjectsResult.rows.map((row) => [row.label, row.id])),
  };
}

async function ensureAuthorCached(pool: Pool, state: ImportState, authorName: string) {
  const key = authorName.toLowerCase();
  const existing = state.authorIdsByLowerName.get(key);
  if (existing) {
    return existing;
  }
  const authorId = crypto.randomUUID();
  await pool.query(
    `INSERT INTO authors (id, name, sort_name, created_at) VALUES ($1, $2, $3, CURRENT_TIMESTAMP)`,
    [authorId, authorName, authorName],
  );
  state.authorIdsByLowerName.set(key, authorId);
  return authorId;
}

async function ensureSubjectCached(pool: Pool, state: ImportState, subjectLabel: string) {
  const existing = state.subjectIdsByLabel.get(subjectLabel);
  if (existing) {
    return existing;
  }
  const subjectId = crypto.randomUUID();
  await pool.query(
    `INSERT INTO subjects (id, label) VALUES ($1, $2) ON CONFLICT (label) DO NOTHING`,
    [subjectId, subjectLabel],
  );
  const resolved = (
    await pool.query<{ id: string }>(`SELECT id FROM subjects WHERE label = $1 LIMIT 1`, [subjectLabel])
  ).rows[0]?.id;
  if (!resolved) {
    throw new Error(`Failed to resolve subject ${subjectLabel}`);
  }
  state.subjectIdsByLabel.set(subjectLabel, resolved);
  return resolved;
}

function normalizeManifest(manifest: BookManifest): NormalizedManifest | null {
  const work = manifest.d1Records?.work;
  if (!work) {
    return null;
  }
  return {
    work,
    workFiles: (manifest.d1Records?.workFiles ?? []).map((file) => ({
      id: `${work.id}:${file.kind}`,
      work_id: work.id,
      kind: file.kind,
      r2_key: file.r2_key,
    })),
    authorNames: uniqueStrings(manifest.d1Records?.authors),
    subjectLabels: uniqueStrings(manifest.d1Records?.subjects),
  };
}

function chunkArray<T>(values: T[], size: number) {
  const chunks: T[][] = [];
  for (let index = 0; index < values.length; index += size) {
    chunks.push(values.slice(index, index + size));
  }
  return chunks;
}

async function bulkUpsertWorks(pool: Pool, works: ManifestWorkRecord[]) {
  if (works.length === 0) {
    return;
  }
  await pool.query(
    `
      INSERT INTO works (
        id, gutenberg_id, title, language, release_date, rights_status, summary, metadata_json, created_at, updated_at
      )
      SELECT
        x.id,
        x.gutenberg_id,
        x.title,
        x.language,
        x.release_date,
        x.rights_status,
        x.summary,
        x.metadata_json::jsonb::text,
        CURRENT_TIMESTAMP,
        CURRENT_TIMESTAMP
      FROM jsonb_to_recordset($1::jsonb) AS x(
        id text,
        gutenberg_id integer,
        title text,
        language text,
        release_date text,
        rights_status text,
        summary text,
        metadata_json jsonb
      )
      ON CONFLICT (id) DO UPDATE SET
        gutenberg_id = EXCLUDED.gutenberg_id,
        title = EXCLUDED.title,
        language = EXCLUDED.language,
        release_date = EXCLUDED.release_date,
        rights_status = EXCLUDED.rights_status,
        summary = EXCLUDED.summary,
        metadata_json = EXCLUDED.metadata_json,
        updated_at = CURRENT_TIMESTAMP
    `,
    [JSON.stringify(works)],
  );
}

async function bulkUpsertWorkFiles(pool: Pool, workIds: string[], workFiles: NormalizedManifest["workFiles"]) {
  if (workIds.length === 0) {
    return;
  }
  await pool.query(`DELETE FROM work_files WHERE work_id = ANY($1::text[])`, [workIds]);
  if (workFiles.length === 0) {
    return;
  }
  await pool.query(
    `
      INSERT INTO work_files (id, work_id, kind, r2_key, byte_size, sha256, metadata_json, created_at)
      SELECT
        x.id,
        x.work_id,
        x.kind,
        x.r2_key,
        NULL,
        NULL,
        '{}'::jsonb::text,
        CURRENT_TIMESTAMP
      FROM jsonb_to_recordset($1::jsonb) AS x(
        id text,
        work_id text,
        kind text,
        r2_key text
      )
      ON CONFLICT (id) DO UPDATE SET
        work_id = EXCLUDED.work_id,
        kind = EXCLUDED.kind,
        r2_key = EXCLUDED.r2_key
    `,
    [JSON.stringify(workFiles)],
  );
}

async function bulkEnsureAuthors(pool: Pool, state: ImportState, authorNames: string[]) {
  const missing = uniqueStrings(authorNames).filter((name) => !state.authorIdsByLowerName.has(name.toLowerCase()));
  if (missing.length === 0) {
    return;
  }
  const rows = missing.map((name) => ({ id: crypto.randomUUID(), name, sort_name: name }));
  await pool.query(
    `
      INSERT INTO authors (id, name, sort_name, created_at)
      SELECT x.id, x.name, x.sort_name, CURRENT_TIMESTAMP
      FROM jsonb_to_recordset($1::jsonb) AS x(id text, name text, sort_name text)
    `,
    [JSON.stringify(rows)],
  );
  for (const row of rows) {
    state.authorIdsByLowerName.set(row.name.toLowerCase(), row.id);
  }
}

async function bulkEnsureSubjects(pool: Pool, state: ImportState, subjectLabels: string[]) {
  const missing = uniqueStrings(subjectLabels).filter((label) => !state.subjectIdsByLabel.has(label));
  if (missing.length === 0) {
    return;
  }
  const rows = missing.map((label) => ({ id: crypto.randomUUID(), label }));
  await pool.query(
    `
      INSERT INTO subjects (id, label)
      SELECT x.id, x.label
      FROM jsonb_to_recordset($1::jsonb) AS x(id text, label text)
      ON CONFLICT (label) DO NOTHING
    `,
    [JSON.stringify(rows)],
  );
  const refreshed = await pool.query<{ id: string; label: string }>(
    `SELECT id, label FROM subjects WHERE label = ANY($1::text[])`,
    [missing],
  );
  for (const row of refreshed.rows) {
    state.subjectIdsByLabel.set(row.label, row.id);
  }
}

async function bulkReplaceWorkAuthors(pool: Pool, state: ImportState, manifests: NormalizedManifest[]) {
  const workIds = manifests.map((manifest) => manifest.work.id);
  await pool.query(`DELETE FROM work_authors WHERE work_id = ANY($1::text[])`, [workIds]);
  const rows = manifests.flatMap((manifest) =>
    manifest.authorNames.map((authorName) => ({
      work_id: manifest.work.id,
      author_id: state.authorIdsByLowerName.get(authorName.toLowerCase()) ?? "",
    }))
  ).filter((row) => row.author_id);
  if (rows.length === 0) {
    return;
  }
  await pool.query(
    `
      INSERT INTO work_authors (work_id, author_id)
      SELECT x.work_id, x.author_id
      FROM jsonb_to_recordset($1::jsonb) AS x(work_id text, author_id text)
      ON CONFLICT DO NOTHING
    `,
    [JSON.stringify(rows)],
  );
}

async function bulkReplaceWorkSubjects(pool: Pool, state: ImportState, manifests: NormalizedManifest[]) {
  const workIds = manifests.map((manifest) => manifest.work.id);
  await pool.query(`DELETE FROM work_subjects WHERE work_id = ANY($1::text[])`, [workIds]);
  const rows = manifests.flatMap((manifest) =>
    manifest.subjectLabels.map((subjectLabel) => ({
      work_id: manifest.work.id,
      subject_id: state.subjectIdsByLabel.get(subjectLabel) ?? "",
    }))
  ).filter((row) => row.subject_id);
  if (rows.length === 0) {
    return;
  }
  await pool.query(
    `
      INSERT INTO work_subjects (work_id, subject_id)
      SELECT x.work_id, x.subject_id
      FROM jsonb_to_recordset($1::jsonb) AS x(work_id text, subject_id text)
      ON CONFLICT DO NOTHING
    `,
    [JSON.stringify(rows)],
  );
}

async function importManifestBatch(pool: Pool, state: ImportState, manifests: NormalizedManifest[]) {
  const workIds = manifests.map((manifest) => manifest.work.id);
  await pool.query("BEGIN");
  try {
    await bulkEnsureAuthors(pool, state, manifests.flatMap((manifest) => manifest.authorNames));
    await bulkEnsureSubjects(pool, state, manifests.flatMap((manifest) => manifest.subjectLabels));
    await bulkUpsertWorks(pool, manifests.map((manifest) => manifest.work));
    await bulkUpsertWorkFiles(pool, workIds, manifests.flatMap((manifest) => manifest.workFiles));
    await bulkReplaceWorkAuthors(pool, state, manifests);
    await bulkReplaceWorkSubjects(pool, state, manifests);
    await pool.query("COMMIT");
  } catch (error) {
    await pool.query("ROLLBACK");
    throw error;
  }
}

async function refreshFeedSnapshot(pool: Pool, limit: number) {
  await pool.query(`DELETE FROM feed_works`);
  await pool.query(
    `
      INSERT INTO feed_works (
        work_id, rank, score, feed_label, title, gutenberg_id, language, release_date,
        rights_status, summary, metadata_json, authors_json, subjects_json, updated_at
      )
      SELECT
        id,
        rank - 1,
        score,
        feed_label,
        title,
        gutenberg_id,
        language,
        release_date,
        rights_status,
        summary,
        metadata_json,
        authors_json,
        subjects_json,
        CURRENT_TIMESTAMP
      FROM (
        SELECT
          w.id,
          w.gutenberg_id,
          w.title,
          w.language,
          w.release_date,
          w.rights_status,
          w.summary,
          w.metadata_json,
          COALESCE(json_agg(DISTINCT a.name) FILTER (WHERE a.name IS NOT NULL), '[]'::json)::text AS authors_json,
          COALESCE(json_agg(DISTINCT s.label) FILTER (WHERE s.label IS NOT NULL), '[]'::json)::text AS subjects_json,
          (
            CASE WHEN COALESCE(
              jsonb_extract_path_text((w.metadata_json)::jsonb, 'coverImageKey'),
              jsonb_extract_path_text((w.metadata_json)::jsonb, 'coverImageUrl'),
              jsonb_extract_path_text((w.metadata_json)::jsonb, 'coverUrl'),
              jsonb_extract_path_text((w.metadata_json)::jsonb, 'imageUrl'),
              jsonb_extract_path_text((w.metadata_json)::jsonb, 'thumbnailUrl')
            ) IS NOT NULL THEN 0.9 ELSE 0 END
            + CASE WHEN w.summary IS NOT NULL AND BTRIM(w.summary) <> '' THEN 0.8 ELSE 0 END
            + CASE WHEN EXISTS(SELECT 1 FROM work_authors wa2 WHERE wa2.work_id = w.id) THEN 0.35 ELSE 0 END
            + LEAST(3, COALESCE(jsonb_array_length(COALESCE(jsonb_extract_path((w.metadata_json)::jsonb, 'bookshelves'), '[]'::jsonb)), 0)) * 0.18
          ) AS score,
          CASE
            WHEN COALESCE(
              jsonb_extract_path_text((w.metadata_json)::jsonb, 'coverImageKey'),
              jsonb_extract_path_text((w.metadata_json)::jsonb, 'coverImageUrl'),
              jsonb_extract_path_text((w.metadata_json)::jsonb, 'coverUrl'),
              jsonb_extract_path_text((w.metadata_json)::jsonb, 'imageUrl'),
              jsonb_extract_path_text((w.metadata_json)::jsonb, 'thumbnailUrl')
            ) IS NOT NULL AND w.summary IS NOT NULL AND BTRIM(w.summary) <> '' THEN 'Curated picks'
            WHEN COALESCE(jsonb_array_length(COALESCE(jsonb_extract_path((w.metadata_json)::jsonb, 'bookshelves'), '[]'::jsonb)), 0) > 0 THEN 'Shelf highlights'
            ELSE 'Library picks'
          END AS feed_label,
          ROW_NUMBER() OVER (
            ORDER BY
              (
                CASE WHEN COALESCE(
                  jsonb_extract_path_text((w.metadata_json)::jsonb, 'coverImageKey'),
                  jsonb_extract_path_text((w.metadata_json)::jsonb, 'coverImageUrl'),
                  jsonb_extract_path_text((w.metadata_json)::jsonb, 'coverUrl'),
                  jsonb_extract_path_text((w.metadata_json)::jsonb, 'imageUrl'),
                  jsonb_extract_path_text((w.metadata_json)::jsonb, 'thumbnailUrl')
                ) IS NOT NULL THEN 0.9 ELSE 0 END
                + CASE WHEN w.summary IS NOT NULL AND BTRIM(w.summary) <> '' THEN 0.8 ELSE 0 END
                + CASE WHEN EXISTS(SELECT 1 FROM work_authors wa2 WHERE wa2.work_id = w.id) THEN 0.35 ELSE 0 END
                + LEAST(3, COALESCE(jsonb_array_length(COALESCE(jsonb_extract_path((w.metadata_json)::jsonb, 'bookshelves'), '[]'::jsonb)), 0)) * 0.18
              ) DESC,
              w.title ASC
          ) AS rank
        FROM works w
        LEFT JOIN work_authors wa ON wa.work_id = w.id
        LEFT JOIN authors a ON a.id = wa.author_id
        LEFT JOIN work_subjects ws ON ws.work_id = w.id
        LEFT JOIN subjects s ON s.id = ws.subject_id
        GROUP BY w.id, w.gutenberg_id, w.title, w.language, w.release_date, w.rights_status, w.summary, w.metadata_json
      ) ranked
      WHERE rank <= $1
    `,
    [limit],
  );

  await pool.query(
    `
      INSERT INTO site_stats (key, value_json, updated_at)
      VALUES ('corpus_work_count', $1, CURRENT_TIMESTAMP)
      ON CONFLICT (key) DO UPDATE SET value_json = EXCLUDED.value_json, updated_at = CURRENT_TIMESTAMP
    `,
    [JSON.stringify({
      count: Number((await pool.query<{ count: string }>(`SELECT COUNT(*)::text AS count FROM works`)).rows[0]?.count ?? "0"),
    })],
  );
}

async function main() {
  const booksRoot = resolve(process.argv[2] ?? "");
  if (!booksRoot || booksRoot === resolve(process.cwd())) {
    throw new Error("Usage: tsx packages/tooling/scripts/import-corpus-manifests.ts <books-root>");
  }
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    throw new Error("DATABASE_URL is required");
  }

  const pool = new Pool({ connectionString: databaseUrl });
  try {
    const manifestPaths = await listManifestPaths(booksRoot);
    const state = await loadImportState(pool);
    const normalized: NormalizedManifest[] = [];
    let imported = 0;
    let skipped = 0;

    for (const manifestPath of manifestPaths) {
      const manifest = await parseManifest(manifestPath);
      const record = manifest ? normalizeManifest(manifest) : null;
      if (!record) {
        skipped += 1;
        continue;
      }
      normalized.push(record);
    }

    for (const batch of chunkArray(normalized, 250)) {
      await importManifestBatch(pool, state, batch);
      imported += batch.length;
      if (imported % 1000 === 0 || imported === normalized.length) {
        console.log(`imported ${imported}/${normalized.length}`);
      }
    }

    await refreshFeedSnapshot(pool, 512);

    const counts = await pool.query<{
      works: string;
      work_files: string;
      authors: string;
      subjects: string;
      feed_works: string;
    }>(
      `
        SELECT
          (SELECT COUNT(*)::text FROM works) AS works,
          (SELECT COUNT(*)::text FROM work_files) AS work_files,
          (SELECT COUNT(*)::text FROM authors) AS authors,
          (SELECT COUNT(*)::text FROM subjects) AS subjects,
          (SELECT COUNT(*)::text FROM feed_works) AS feed_works
      `,
    );

    console.log(JSON.stringify({
      imported,
      skipped,
      counts: counts.rows[0] ?? null,
    }, null, 2));
  } finally {
    await pool.end();
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack ?? error.message : error);
  process.exitCode = 1;
});
