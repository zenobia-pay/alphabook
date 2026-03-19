import process from "node:process";
import crypto from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

import { DeleteObjectsCommand, GetObjectCommand, S3Client, PutObjectCommand } from "@aws-sdk/client-s3";
import { parseHTML } from "linkedom";
import { createNeonDb } from "@alphabook/db";
import { listMirrorIds, resolveMirrorSource } from "@alphabook/source-gutenberg/mirror";
import { gutenbergCorpusKeys } from "@alphabook/source-gutenberg/storage";
import { chunkCorpusText, normalizeCorpusText, stripGutenbergBoilerplate } from "@alphabook/source-gutenberg/text";

interface IngestContext {
  db: ReturnType<typeof createNeonDb>;
  r2: S3Client;
  r2Bucket: string;
}

interface IngestSourceInput {
  gutenbergId: string;
  title: string;
  rawSource: string;
  rawText: string;
  sourceFormat?: "text" | "html";
  authors?: string[];
  subjects?: string[];
  language?: string | null;
  releaseDate?: string | null;
  rightsStatus?: string | null;
  summary?: string | null;
  sourceUrl?: string;
  sourcePath?: string;
  metadata?: Record<string, unknown>;
}

interface MirrorBackfillOptions {
  startAfterId?: string | null;
  limit: number;
  checkpointPath?: string | null;
  concurrency?: number;
}

interface MirrorBackfillCheckpoint {
  lastProcessedId: string | null;
  processed: number;
  updatedAt: string;
}

interface ExistingWorkStatus {
  workId: string;
  complete: boolean;
}

interface ExistingBookHtmlWork {
  workId: string;
  gutenbergId: string;
  title: string;
  summary: string | null;
  language: string | null;
  releaseDate: string | null;
  metadata: Record<string, unknown>;
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function embedChunks(chunks: string[]): Promise<number[][] | null> {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey || chunks.length === 0) {
    return null;
  }

  const model = process.env.OPENAI_EMBEDDING_MODEL ?? "text-embedding-3-small";
  const embeddings: number[][] = [];

  for (let index = 0; index < chunks.length; index += 32) {
    const batch = chunks.slice(index, index + 32);
    let response: Response | null = null;
    let lastError: string | null = null;

    for (let attempt = 0; attempt < 5; attempt += 1) {
      try {
        response = await fetch("https://api.openai.com/v1/embeddings", {
          method: "POST",
          headers: {
            "content-type": "application/json",
            authorization: `Bearer ${apiKey}`,
          },
          body: JSON.stringify({
            model,
            input: batch,
            ...(model.startsWith("text-embedding-3-") ? { dimensions: 1536 } : {}),
          }),
        });
        if (response.ok) {
          break;
        }
        const body = await response.text();
        lastError = `Embedding request failed: ${response.status} ${body}`;
        if (response.status !== 429 && response.status < 500) {
          throw new Error(lastError);
        }
      } catch (error) {
        lastError = error instanceof Error ? error.message : String(error);
      }

      if (attempt < 4) {
        await sleep(1000 * 2 ** attempt);
      }
    }

    if (!response?.ok) {
      throw new Error(lastError ?? "Embedding request failed.");
    }

    const payload = (await response.json()) as {
      data?: Array<{
        embedding?: number[];
      }>;
    };
    const nextVectors = (payload.data ?? []).map((item) => item.embedding ?? []);
    embeddings.push(...nextVectors);
  }

  if (embeddings.length !== chunks.length || embeddings.some((vector) => vector.length === 0)) {
    throw new Error("Embedding response length did not match the number of chunks.");
  }

  return embeddings;
}

function vectorLiteral(embedding: number[] | null | undefined) {
  return embedding?.length ? `[${embedding.join(",")}]` : null;
}

function uniqueStrings(values: Array<string | null | undefined>) {
  const seen = new Set<string>();
  const normalized: string[] = [];
  for (const value of values) {
    const next = value?.trim();
    if (!next) {
      continue;
    }
    const key = next.toLowerCase();
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    normalized.push(next);
  }
  return normalized;
}

function escapeHtml(value: string) {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll("\"", "&quot;")
    .replaceAll("'", "&#39;");
}

function stripTags(value: string) {
  return value.replace(/<[^>]+>/g, " ");
}

function normalizeWhitespace(value: string) {
  return value.replace(/\s+/g, " ").trim();
}

function normalizeReaderText(input: string, preserveLineBreaks = false) {
  const normalized = input
    .replace(/\u00a0/g, " ")
    .replace(/\r\n/g, "\n")
    .replace(/[ \t]+\n/g, "\n")
    .trim();

  if (preserveLineBreaks) {
    return normalized.replace(/\n{3,}/g, "\n\n").trim();
  }

  return normalized.replace(/\s+/g, " ").trim();
}

function hashText(value: string) {
  let hash = 0;
  for (const character of value) {
    hash = (hash * 33 + character.charCodeAt(0)) >>> 0;
  }
  return hash.toString(36);
}

function createReaderPassageId(index: number, text: string) {
  return `passage-${index + 1}-${hashText(text).slice(0, 6)}`;
}

function createExcerpt(value: string, maxLength = 240) {
  const normalized = normalizeWhitespace(stripTags(value));
  if (normalized.length <= maxLength) {
    return normalized;
  }
  return `${normalized.slice(0, maxLength - 1).trimEnd()}…`;
}

function sanitizeSourceHtml(content: string) {
  const bodyMatch = content.match(/<body[^>]*>([\s\S]*?)<\/body>/i);
  const extracted = bodyMatch?.[1] ?? content;
  return extracted
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, "")
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, "")
    .replace(/<(?:link|meta|base|iframe|object|embed|form|input|button)[^>]*>/gi, "")
    .replace(/\son[a-z]+\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)/gi, "")
    .replace(/\s(?:href|src)\s*=\s*(['"])\s*javascript:[\s\S]*?\1/gi, "");
}

function renderTextSource(content: string) {
  const paragraphs = stripGutenbergBoilerplate(content)
    .replace(/\r\n/g, "\n")
    .split(/\n{2,}/)
    .map((paragraph) => normalizeReaderText(paragraph, true))
    .filter((paragraph) => paragraph.length > 0);

  if (paragraphs.length === 0) {
    return `<p class="empty-state">This work does not have stored source content yet.</p>`;
  }

  return paragraphs
    .map((paragraph, index) => {
      const passageId = createReaderPassageId(index, paragraph);
      return `<p id="${passageId}" data-passage-id="${passageId}">${escapeHtml(paragraph).replace(/\n/g, "<br />")}</p>`;
    })
    .join("\n");
}

function renderAnchoredHtmlSource(content: string) {
  const sanitized = sanitizeSourceHtml(content);
  const { document } = parseHTML(`<!doctype html><html><body>${sanitized}</body></html>`);

  for (const node of Array.from(document.querySelectorAll("script, style, link, meta, base, noscript, iframe"))) {
    node.remove();
  }

  const selector = "h1, h2, h3, h4, h5, h6, p, li, blockquote, pre";
  const blocks = Array.from(document.body.querySelectorAll(selector)).filter((element) => !element.parentElement?.closest(selector));
  let passageIndex = 0;

  for (const element of blocks) {
    const tagName = element.tagName.toLowerCase();
    const rawText = tagName === "pre"
      ? element.textContent ?? ""
      : (element.textContent ?? "").replace(/\s+/g, " ");
    const text = normalizeReaderText(rawText, tagName === "pre");
    if (!text) {
      continue;
    }

    const passageText = tagName === "li" ? `• ${text}` : text;
    const passageId = createReaderPassageId(passageIndex, passageText);
    passageIndex += 1;
    element.setAttribute("id", passageId);
    element.setAttribute("data-passage-id", passageId);
  }

  return document.body.innerHTML;
}

function renderSourceMarkup(rawSource: string, sourceFormat: "text" | "html") {
  return sourceFormat === "html" ? renderAnchoredHtmlSource(rawSource) : renderTextSource(rawSource);
}

function renderTagList(values: string[] | null | undefined) {
  const tags = (values ?? []).filter((value) => value.trim().length > 0).slice(0, 12);
  if (tags.length === 0) {
    return "";
  }
  return `<div class="chip-row">${tags.map((value) => `<span>${escapeHtml(value)}</span>`).join("")}</div>`;
}

function buildBookHtmlArtifact(input: {
  gutenbergId: string;
  title: string;
  subtitle?: string | null;
  authors: string[];
  bookshelves?: string[];
  summary?: string | null;
  language?: string | null;
  releaseDate?: string | null;
  rawSource: string;
  sourceFormat: "text" | "html";
}) {
  const meta = [
    input.gutenbergId ? `Project Gutenberg #${input.gutenbergId}` : null,
    input.language ? input.language.toUpperCase() : null,
    input.releaseDate ? input.releaseDate.slice(0, 4) : null,
  ].filter((value): value is string => Boolean(value)).join(" · ");
  const byline = input.authors.filter((author) => author.trim().length > 0).join(" · ");
  const description = createExcerpt(input.summary ?? input.rawSource ?? input.title);
  const sourceMarkup = renderSourceMarkup(input.rawSource, input.sourceFormat);

  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>${escapeHtml(input.title)} | alpha book</title>
    <meta name="description" content="${escapeHtml(description)}" />
    <meta name="robots" content="noindex,nofollow" />
    <style>
      :root {
        color-scheme: light;
        --bg: #f8f4ee;
        --ink: #1f1b16;
        --muted: #635848;
        --line: rgba(73, 58, 41, 0.14);
        --accent-soft: rgba(143, 79, 42, 0.12);
      }
      * { box-sizing: border-box; }
      html { scroll-behavior: smooth; }
      body {
        margin: 0;
        font-family: Georgia, "Times New Roman", serif;
        color: var(--ink);
        background: var(--bg);
      }
      .page {
        width: min(880px, calc(100vw - 40px));
        margin: 0 auto;
        padding: 28px 0 40px;
      }
      .hero {
        display: grid;
        gap: 10px;
        padding-bottom: 22px;
      }
      .eyebrow, .byline, .summary {
        margin: 0;
        color: var(--muted);
        font-size: 1rem;
        line-height: 1.7;
      }
      h1 {
        margin: 0;
        font-size: clamp(2rem, 4vw, 3.5rem);
        line-height: 0.98;
      }
      .chip-row {
        display: flex;
        flex-wrap: wrap;
        gap: 10px;
      }
      .chip-row span {
        display: inline-flex;
        align-items: center;
        border-radius: 999px;
        padding: 8px 12px;
        background: var(--accent-soft);
        color: var(--muted);
        font-size: 0.88rem;
      }
      .reader-body {
        padding: 0 0 32px;
        font-size: 1.1rem;
        line-height: 1.85;
      }
      .reader-body h1, .reader-body h2, .reader-body h3, .reader-body h4, .reader-body h5, .reader-body h6 {
        font-size: 1.4em;
        line-height: 1.2;
        margin: 1.8em 0 0.75em;
      }
      .reader-body p, .reader-body li, .reader-body blockquote, .reader-body pre {
        margin: 0 0 1.15em;
      }
      .reader-body [data-passage-id] {
        scroll-margin-top: 24px;
      }
      .reader-body :target {
        background: rgba(143, 79, 42, 0.12);
        border-radius: 10px;
        outline: none;
      }
      .reader-body blockquote {
        margin-left: 0;
        padding-left: 18px;
        border-left: 3px solid var(--accent-soft);
        color: var(--muted);
      }
      .reader-body pre {
        white-space: pre-wrap;
        font-family: "Courier New", monospace;
        background: #f2eadf;
        border-radius: 16px;
        padding: 16px;
      }
      .empty-state {
        color: var(--muted);
      }
      @media (max-width: 780px) {
        .page { width: min(100vw - 24px, 100%); }
      }
    </style>
  </head>
  <body>
    <main class="page">
      <section class="hero">
        ${meta ? `<p class="eyebrow">${escapeHtml(meta)}</p>` : ""}
        <h1>${escapeHtml(input.title)}</h1>
        ${input.subtitle ? `<p class="summary">${escapeHtml(input.subtitle)}</p>` : ""}
        ${byline ? `<p class="byline">${escapeHtml(byline)}</p>` : ""}
        ${input.summary ? `<p class="summary">${escapeHtml(input.summary)}</p>` : ""}
        ${renderTagList(input.bookshelves)}
      </section>
      <div class="reader-body">${sourceMarkup}</div>
    </main>
  </body>
</html>`;
}

async function getText(r2: S3Client, bucket: string, key: string): Promise<string | null> {
  const response = await r2.send(new GetObjectCommand({
    Bucket: bucket,
    Key: key,
  }));
  if (!response.Body) {
    return null;
  }
  return await response.Body.transformToString();
}

function shouldSkipExistingWork() {
  return process.env.FORCE_REINGEST !== "1";
}

async function findExistingWorkStatus(context: IngestContext, gutenbergId: string): Promise<ExistingWorkStatus | null> {
  const rows = await context.db.query<{
    work_id: string;
    file_kind_count: number | string;
    chunk_count: number | string;
  }>(
    `
      SELECT
        w.id AS work_id,
        COUNT(DISTINCT wf.kind) FILTER (WHERE wf.kind IN ('raw', 'metadata', 'clean', 'chunks', 'book_html')) AS file_kind_count,
        COUNT(c.id) AS chunk_count
      FROM works w
      LEFT JOIN work_files wf ON wf.work_id = w.id
      LEFT JOIN chunks c ON c.work_id = w.id
      WHERE w.gutenberg_id = $1::bigint
      GROUP BY w.id
      LIMIT 1
    `,
    [Number(gutenbergId)],
  );
  const row = rows.rows[0];
  if (!row) {
    return null;
  }
  return {
    workId: row.work_id,
    complete: Number(row.file_kind_count) >= 5 && Number(row.chunk_count) > 0,
  };
}

async function putText(r2: S3Client, bucket: string, key: string, body: string, contentType: string) {
  await r2.send(
    new PutObjectCommand({
      Bucket: bucket,
      Key: key,
      Body: body,
      ContentType: contentType,
    }),
  );
}

async function putBytes(r2: S3Client, bucket: string, key: string, body: Uint8Array, contentType: string) {
  await r2.send(
    new PutObjectCommand({
      Bucket: bucket,
      Key: key,
      Body: body,
      ContentType: contentType,
    }),
  );
}

function coverContentType(path: string): string {
  if (/\.png$/i.test(path)) return "image/png";
  if (/\.webp$/i.test(path)) return "image/webp";
  return "image/jpeg";
}

function coverExtension(path: string): string {
  if (/\.png$/i.test(path)) return "png";
  if (/\.webp$/i.test(path)) return "webp";
  return "jpg";
}

async function deleteKeys(r2: S3Client, bucket: string, keys: string[]) {
  const uniqueKeys = [...new Set(keys.filter(Boolean))];
  if (uniqueKeys.length === 0) {
    return;
  }

  for (let index = 0; index < uniqueKeys.length; index += 1000) {
    const batch = uniqueKeys.slice(index, index + 1000);
    await r2.send(
      new DeleteObjectsCommand({
        Bucket: bucket,
        Delete: {
          Objects: batch.map((Key) => ({ Key })),
          Quiet: true,
        },
      }),
    );
  }
}

async function syncAuthors(context: IngestContext, workId: string, authors: string[]) {
  const normalizedAuthors = uniqueStrings(authors);
  await context.db.query(`DELETE FROM work_authors WHERE work_id = $1::uuid`, [workId]);

  for (const authorName of normalizedAuthors) {
    const existing = await context.db.query<{ id: string }>(
      `SELECT id FROM authors WHERE lower(name) = lower($1) LIMIT 1`,
      [authorName],
    );
    const authorId = existing.rows[0]?.id ?? crypto.randomUUID();
    if (!existing.rows[0]?.id) {
      await context.db.query(
        `INSERT INTO authors (id, name, sort_name) VALUES ($1::uuid, $2, $3)`,
        [authorId, authorName, authorName],
      );
    }
    await context.db.query(
      `INSERT INTO work_authors (work_id, author_id) VALUES ($1::uuid, $2::uuid) ON CONFLICT DO NOTHING`,
      [workId, authorId],
    );
  }
}

async function syncSubjects(context: IngestContext, workId: string, subjects: string[]) {
  const normalizedSubjects = uniqueStrings(subjects);
  await context.db.query(`DELETE FROM work_subjects WHERE work_id = $1::uuid`, [workId]);

  for (const subjectLabel of normalizedSubjects) {
    const existing = await context.db.query<{ id: string }>(
      `SELECT id FROM subjects WHERE label = $1 LIMIT 1`,
      [subjectLabel],
    );
    const subjectId = existing.rows[0]?.id ?? crypto.randomUUID();
    if (!existing.rows[0]?.id) {
      await context.db.query(
        `INSERT INTO subjects (id, label) VALUES ($1::uuid, $2) ON CONFLICT (label) DO NOTHING`,
        [subjectId, subjectLabel],
      );
    }
    const resolved = existing.rows[0]?.id
      ? subjectId
      : (
          await context.db.query<{ id: string }>(
            `SELECT id FROM subjects WHERE label = $1 LIMIT 1`,
            [subjectLabel],
          )
        ).rows[0]?.id;
    if (resolved) {
      await context.db.query(
        `INSERT INTO work_subjects (work_id, subject_id) VALUES ($1::uuid, $2::uuid) ON CONFLICT DO NOTHING`,
        [workId, resolved],
      );
    }
  }
}

async function persistIngestedWork(context: IngestContext, source: IngestSourceInput) {
  if (shouldSkipExistingWork()) {
    const existing = await findExistingWorkStatus(context, source.gutenbergId);
    if (existing?.complete) {
      return {
        workId: existing.workId,
        gutenbergId: source.gutenbergId,
        title: source.title,
        skipped: true,
        reason: "already_ingested",
      };
    }
  }

  const cleanText = normalizeCorpusText(stripGutenbergBoilerplate(source.rawText));
  const chunks = chunkCorpusText(cleanText);
  const chunkEmbeddings = await embedChunks(chunks);
  const authors = uniqueStrings(source.authors ?? []);
  const subjects = uniqueStrings(source.subjects ?? []);

  const rawKey = gutenbergCorpusKeys.rawText(source.gutenbergId);
  const metadataKey = gutenbergCorpusKeys.rawMetadata(source.gutenbergId);
  const cleanKey = gutenbergCorpusKeys.cleanText(source.gutenbergId);
  const chunksKey = gutenbergCorpusKeys.chunks(source.gutenbergId);
  const bookHtmlKey = gutenbergCorpusKeys.bookHtml(source.gutenbergId);
  const coverImagePath = typeof source.metadata?.coverImagePath === "string" ? source.metadata.coverImagePath : null;
  const coverImageKey = coverImagePath ? gutenbergCorpusKeys.coverImage(source.gutenbergId, coverExtension(coverImagePath)) : null;
  const proposedWorkId = crypto.randomUUID();
  const metadataPayload = {
    gutenbergId: source.gutenbergId,
    title: source.title,
    authors,
    subjects,
    subtitle: typeof source.metadata?.subtitle === "string" ? source.metadata.subtitle : null,
    coverImageKey,
    language: source.language ?? null,
    releaseDate: source.releaseDate ?? null,
    rightsStatus: source.rightsStatus ?? "public_domain",
    summary: source.summary ?? null,
    sourceUrl: source.sourceUrl ?? null,
    sourcePath: source.sourcePath ?? null,
    sourceFormat: source.sourceFormat ?? "text",
    ...source.metadata,
  };

  const workResult = await context.db.query<{ id: string }>(
    `
      INSERT INTO works (id, gutenberg_id, title, language, release_date, rights_status, summary, metadata_json)
      VALUES ($1::uuid, $2::bigint, $3, $4, $5::date, $6, $7, $8::jsonb)
      ON CONFLICT (gutenberg_id) DO UPDATE
      SET
        title = EXCLUDED.title,
        language = EXCLUDED.language,
        release_date = EXCLUDED.release_date,
        rights_status = EXCLUDED.rights_status,
        summary = EXCLUDED.summary,
        metadata_json = EXCLUDED.metadata_json,
        updated_at = now()
      RETURNING id
    `,
    [
      proposedWorkId,
      Number(source.gutenbergId),
      source.title,
      source.language ?? null,
      source.releaseDate ?? null,
      source.rightsStatus ?? "public_domain",
      source.summary ?? null,
      JSON.stringify(metadataPayload),
    ],
  );
  const workId = workResult.rows[0]?.id;
  if (!workId) {
    throw new Error(`Failed to resolve work id for Gutenberg ${source.gutenbergId}.`);
  }

  const chunksPayload = chunks
    .map((chunk, index) =>
      JSON.stringify({
        id: crypto.randomUUID(),
        work_id: workId,
        chunk_index: index,
        text: chunk,
        r2_key: chunksKey,
        embedding_dimensions: chunkEmbeddings?.[index]?.length ?? null,
      }),
    )
    .join("\n");
  const bookHtml = buildBookHtmlArtifact({
    gutenbergId: source.gutenbergId,
    title: source.title,
    subtitle: typeof source.metadata?.subtitle === "string" ? source.metadata.subtitle : null,
    authors,
    bookshelves: Array.isArray(source.metadata?.bookshelves)
      ? source.metadata.bookshelves.filter((value): value is string => typeof value === "string")
      : [],
    summary: source.summary ?? null,
    language: source.language ?? null,
    releaseDate: source.releaseDate ?? null,
    rawSource: source.rawSource,
    sourceFormat: source.sourceFormat ?? "text",
  });

  await Promise.all([
    putText(
      context.r2,
      context.r2Bucket,
      rawKey,
      source.rawSource,
      source.sourceFormat === "html" ? "text/html; charset=utf-8" : "text/plain; charset=utf-8",
    ),
    putText(
      context.r2,
      context.r2Bucket,
      metadataKey,
      JSON.stringify(metadataPayload, null, 2),
      "application/json",
    ),
    putText(context.r2, context.r2Bucket, cleanKey, cleanText, "text/plain; charset=utf-8"),
    putText(context.r2, context.r2Bucket, chunksKey, chunksPayload, "application/x-ndjson"),
    putText(context.r2, context.r2Bucket, bookHtmlKey, bookHtml, "text/html; charset=utf-8"),
    ...(coverImagePath && coverImageKey
      ? [
          readFile(coverImagePath).then((bytes) =>
            putBytes(context.r2, context.r2Bucket, coverImageKey, bytes, coverContentType(coverImagePath)),
          ),
        ]
      : []),
  ]);

  await context.db.query(
    `
      INSERT INTO work_files (id, work_id, kind, r2_key, metadata_json)
      VALUES
        ($1::uuid, $2::uuid, 'raw', $3, '{}'::jsonb),
        ($4::uuid, $2::uuid, 'metadata', $5, '{}'::jsonb),
        ($6::uuid, $2::uuid, 'clean', $7, '{}'::jsonb),
        ($8::uuid, $2::uuid, 'chunks', $9, '{}'::jsonb),
        ($10::uuid, $2::uuid, 'book_html', $11, '{}'::jsonb)
      ON CONFLICT (r2_key) DO NOTHING
    `,
    [
      crypto.randomUUID(),
      workId,
      rawKey,
      crypto.randomUUID(),
      metadataKey,
      crypto.randomUUID(),
      cleanKey,
      crypto.randomUUID(),
      chunksKey,
      crypto.randomUUID(),
      bookHtmlKey,
    ],
  );

  for (const [index, chunk] of chunks.entries()) {
    await context.db.query(
      `
        INSERT INTO chunks (id, work_id, chunk_index, text, embedding, tsv, r2_key, metadata_json)
        VALUES (
          $1::uuid,
          $2::uuid,
          $3,
          $4,
          CASE WHEN $5::text IS NULL THEN NULL ELSE $5::vector END,
          to_tsvector('english', $4),
          $6,
          '{}'::jsonb
        )
        ON CONFLICT (work_id, chunk_index) DO UPDATE
        SET text = EXCLUDED.text, embedding = EXCLUDED.embedding, tsv = EXCLUDED.tsv, r2_key = EXCLUDED.r2_key
      `,
      [crypto.randomUUID(), workId, index, chunk, vectorLiteral(chunkEmbeddings?.[index]), chunksKey],
    );
  }

  await syncAuthors(context, workId, authors);
  await syncSubjects(context, workId, subjects);

  return {
    workId,
    gutenbergId: source.gutenbergId,
    title: source.title,
    chunkCount: chunks.length,
    rawKey,
    cleanKey,
    chunksKey,
    bookHtmlKey,
    skipped: false,
  };
}

async function readCheckpoint(path: string): Promise<MirrorBackfillCheckpoint | null> {
  try {
    const raw = await readFile(path, "utf8");
    const parsed = JSON.parse(raw) as Partial<MirrorBackfillCheckpoint>;
    if (typeof parsed.lastProcessedId !== "string" && parsed.lastProcessedId !== null) {
      return null;
    }
    return {
      lastProcessedId: parsed.lastProcessedId ?? null,
      processed: typeof parsed.processed === "number" ? parsed.processed : 0,
      updatedAt: typeof parsed.updatedAt === "string" ? parsed.updatedAt : new Date().toISOString(),
    };
  } catch {
    return null;
  }
}

async function writeCheckpoint(path: string, checkpoint: MirrorBackfillCheckpoint) {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, JSON.stringify(checkpoint, null, 2), "utf8");
}

async function ingestUrl(context: IngestContext, gutenbergId: string, sourceUrl: string, title: string) {
  const response = await fetch(sourceUrl);
  if (!response.ok) {
    throw new Error(`Failed to fetch source URL: ${response.status}`);
  }
  const rawText = await response.text();
  return persistIngestedWork(context, {
    gutenbergId,
    title,
    rawSource: rawText,
    rawText,
    sourceFormat: /html/i.test(response.headers.get("content-type") ?? "") || /\.html?$/i.test(sourceUrl) ? "html" : "text",
    sourceUrl,
    metadata: {
      source: "remote-url",
    },
  });
}

async function ingestFromMirror(context: IngestContext, gutenbergId: string, explicitTitle?: string) {
  const mirrorRoot = process.env.GUTENBERG_MIRROR_ROOT;
  if (!mirrorRoot) {
    throw new Error("GUTENBERG_MIRROR_ROOT is required for ingest-gutenberg.");
  }
  const source = await resolveMirrorSource(mirrorRoot, gutenbergId);
  return persistIngestedWork(context, {
    gutenbergId,
    title: explicitTitle ?? source.title ?? `Project Gutenberg ${gutenbergId}`,
    rawSource: source.rawSource,
    rawText: source.rawText,
    sourceFormat: source.format,
    authors: source.authors,
    subjects: source.subjects,
    language: source.language,
    releaseDate: source.releaseDate,
    rightsStatus: source.rightsStatus,
    summary: source.summary,
    sourcePath: source.sourcePath,
    metadata: {
      source: "local-mirror",
      mirrorRoot,
      metadataPath: source.metadataPath,
      format: source.format,
      subtitle: source.subtitle,
      bookshelves: source.bookshelves,
      publisher: source.publisher,
      translators: source.translators,
      illustrators: source.illustrators,
      editors: source.editors,
      coverImagePath: source.coverImagePath,
      ...source.metadata,
    },
  });
}

async function deleteGutenbergWorks(context: IngestContext, gutenbergIds: string[]) {
  const ids = [...new Set(gutenbergIds.map((id) => id.trim()).filter(Boolean))];
  if (ids.length === 0) {
    return { deleted: 0, ids: [], r2KeysDeleted: 0 };
  }

  const rows = await context.db.query<{ gutenberg_id: number | string | null; r2_key: string | null }>(
    `
      SELECT w.gutenberg_id, wf.r2_key
      FROM works w
      LEFT JOIN work_files wf ON wf.work_id = w.id
      WHERE w.gutenberg_id = ANY($1::bigint[])
    `,
    [ids.map((id) => Number(id))],
  );

  const r2Keys = uniqueStrings([
    ...rows.rows.map((row) => (row.r2_key ? String(row.r2_key) : null)),
    ...ids.flatMap((id) => [
      gutenbergCorpusKeys.rawText(id),
      gutenbergCorpusKeys.rawMetadata(id),
      gutenbergCorpusKeys.cleanText(id),
      gutenbergCorpusKeys.chunks(id),
      gutenbergCorpusKeys.bookHtml(id),
    ]),
  ]);

  await deleteKeys(context.r2, context.r2Bucket, r2Keys);
  await context.db.query(`DELETE FROM works WHERE gutenberg_id = ANY($1::bigint[])`, [ids.map((id) => Number(id))]);
  await context.db.query(`DELETE FROM authors a WHERE NOT EXISTS (SELECT 1 FROM work_authors wa WHERE wa.author_id = a.id)`);
  await context.db.query(`DELETE FROM subjects s WHERE NOT EXISTS (SELECT 1 FROM work_subjects ws WHERE ws.subject_id = s.id)`);

  return {
    deleted: ids.length,
    ids,
    r2KeysDeleted: r2Keys.length,
  };
}

async function listWorksMissingBookHtml(context: IngestContext, limit: number, startAfterGutenbergId?: string | null) {
  const rows = await context.db.query<{
    work_id: string;
    gutenberg_id: string | number;
    title: string;
    summary: string | null;
    language: string | null;
    release_date: string | null;
    metadata_json: Record<string, unknown> | null;
  }>(
    `
      SELECT
        w.id AS work_id,
        w.gutenberg_id::bigint::text AS gutenberg_id,
        w.title,
        w.summary,
        w.language,
        w.release_date::text AS release_date,
        w.metadata_json
      FROM works w
      LEFT JOIN work_files html_file
        ON html_file.work_id = w.id
       AND html_file.kind = 'book_html'
      WHERE w.gutenberg_id IS NOT NULL
        AND html_file.id IS NULL
        AND ($1::bigint IS NULL OR w.gutenberg_id > $1::bigint)
      ORDER BY w.gutenberg_id ASC
      LIMIT $2
    `,
    [startAfterGutenbergId ? Number(startAfterGutenbergId) : null, limit],
  );

  return rows.rows.map((row) => ({
    workId: row.work_id,
    gutenbergId: String(row.gutenberg_id),
    title: row.title,
    summary: row.summary,
    language: row.language,
    releaseDate: row.release_date,
    metadata: row.metadata_json ?? {},
  } satisfies ExistingBookHtmlWork));
}

async function listBookHtmlWorks(context: IngestContext, limit: number, startAfterGutenbergId?: string | null) {
  const rows = await context.db.query<{
    work_id: string;
    gutenberg_id: string;
    title: string;
    summary: string | null;
    language: string | null;
    release_date: string | null;
    metadata_json: Record<string, unknown> | null;
  }>(
    `
      SELECT
        w.id AS work_id,
        w.gutenberg_id::bigint::text AS gutenberg_id,
        w.title,
        w.summary,
        w.language,
        w.release_date::text AS release_date,
        w.metadata_json
      FROM works w
      WHERE w.gutenberg_id IS NOT NULL
        AND ($1::bigint IS NULL OR w.gutenberg_id > $1::bigint)
      ORDER BY w.gutenberg_id ASC
      LIMIT $2
    `,
    [startAfterGutenbergId ? Number(startAfterGutenbergId) : null, limit],
  );

  return rows.rows.map((row) => ({
    workId: row.work_id,
    gutenbergId: String(row.gutenberg_id),
    title: row.title,
    summary: row.summary,
    language: row.language,
    releaseDate: row.release_date,
    metadata: row.metadata_json ?? {},
  } satisfies ExistingBookHtmlWork));
}

async function persistBookHtmlArtifact(
  context: IngestContext,
  work: ExistingBookHtmlWork,
  rawKey?: string | null,
): Promise<{ workId: string; gutenbergId: string; bookHtmlKey: string }> {
  const resolvedRawKey = rawKey ?? gutenbergCorpusKeys.rawText(work.gutenbergId);
  const rawSource = await getText(context.r2, context.r2Bucket, resolvedRawKey);
  if (!rawSource) {
    throw new Error(`Raw source missing for Gutenberg ${work.gutenbergId} (${resolvedRawKey}).`);
  }
  const metadata = work.metadata ?? {};
  const bookHtml = buildBookHtmlArtifact({
    gutenbergId: work.gutenbergId,
    title: work.title,
    subtitle: typeof metadata.subtitle === "string" ? metadata.subtitle : null,
    authors: Array.isArray(metadata.authors) ? metadata.authors.filter((value): value is string => typeof value === "string") : [],
    bookshelves: Array.isArray(metadata.bookshelves) ? metadata.bookshelves.filter((value): value is string => typeof value === "string") : [],
    summary: work.summary ?? null,
    language: work.language ?? null,
    releaseDate: work.releaseDate ?? null,
    rawSource,
    sourceFormat: metadata.sourceFormat === "html" ? "html" : "text",
  });
  const bookHtmlKey = gutenbergCorpusKeys.bookHtml(work.gutenbergId);

  await putText(context.r2, context.r2Bucket, bookHtmlKey, bookHtml, "text/html; charset=utf-8");
  await context.db.query(
    `
      INSERT INTO work_files (id, work_id, kind, r2_key, metadata_json)
      VALUES ($1::uuid, $2::uuid, 'book_html', $3, '{}'::jsonb)
      ON CONFLICT (r2_key) DO NOTHING
    `,
    [crypto.randomUUID(), work.workId, bookHtmlKey],
  );

  return {
    workId: work.workId,
    gutenbergId: work.gutenbergId,
    bookHtmlKey,
  };
}

async function backfillBookHtml(
  context: IngestContext,
  options: { startAfterId?: string | null; limit: number; concurrency?: number },
) {
  const works = await listWorksMissingBookHtml(context, options.limit, options.startAfterId ?? null);
  const results: Array<Record<string, unknown>> = [];

  const concurrency = Math.max(1, Number(options.concurrency ?? process.env.BOOK_HTML_BACKFILL_CONCURRENCY ?? "8"));
  let cursor = 0;

  async function worker() {
    while (cursor < works.length) {
      const work = works[cursor++];
      const result = await persistBookHtmlArtifact(context, work);
      results.push(result);
    }
  }

  await Promise.all(Array.from({ length: Math.min(concurrency, works.length || 1) }, () => worker()));

  return {
    processed: results.length,
    nextStartAfterId: works.length > 0 ? works[works.length - 1].gutenbergId : options.startAfterId ?? null,
    results,
  };
}

async function rebuildBookHtml(
  context: IngestContext,
  options: { startAfterId?: string | null; limit: number; concurrency?: number },
) {
  const works = await listBookHtmlWorks(context, options.limit, options.startAfterId ?? null);
  const results: Array<Record<string, unknown>> = [];

  const concurrency = Math.max(1, Number(options.concurrency ?? process.env.BOOK_HTML_REBUILD_CONCURRENCY ?? "8"));
  let cursor = 0;

  async function worker() {
    while (cursor < works.length) {
      const work = works[cursor++];
      const result = await persistBookHtmlArtifact(context, work);
      results.push(result);
    }
  }

  await Promise.all(Array.from({ length: Math.min(concurrency, works.length || 1) }, () => worker()));

  return {
    processed: results.length,
    nextStartAfterId: works.length > 0 ? works[works.length - 1].gutenbergId : options.startAfterId ?? null,
    results,
  };
}

async function backfillMirror(context: IngestContext, options: MirrorBackfillOptions) {
  const mirrorRoot = process.env.GUTENBERG_MIRROR_ROOT;
  if (!mirrorRoot) {
    throw new Error("GUTENBERG_MIRROR_ROOT is required for mirror backfill.");
  }

  const checkpoint = options.checkpointPath ? await readCheckpoint(options.checkpointPath) : null;
  const startAfterId = options.startAfterId ?? checkpoint?.lastProcessedId ?? null;
  const allIds = await listMirrorIds(mirrorRoot);
  const firstGreaterIndex = startAfterId ? allIds.findIndex((id) => Number(id) > Number(startAfterId)) : -1;
  const startIndex = startAfterId ? (firstGreaterIndex >= 0 ? firstGreaterIndex : allIds.length) : 0;
  const selectedIds = allIds.slice(startIndex, startIndex + options.limit);
  const results: Array<Record<string, unknown>> = [];
  const errors: Array<Record<string, unknown>> = [];
  let lastProcessedId = startAfterId;

  for (const gutenbergId of selectedIds) {
    try {
      const result = await ingestFromMirror(context, gutenbergId);
      results.push(result);
    } catch (error) {
      errors.push({
        gutenbergId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
    lastProcessedId = gutenbergId;
    if (options.checkpointPath) {
      await writeCheckpoint(options.checkpointPath, {
        lastProcessedId,
        processed: (checkpoint?.processed ?? 0) + results.length + errors.length,
        updatedAt: new Date().toISOString(),
      });
    }
  }

  return {
    mirrorRoot,
    startAfterId,
    processed: results.length + errors.length,
    inserted: results.length,
    errors,
    nextStartAfterId: selectedIds.length > 0 ? selectedIds[selectedIds.length - 1] : startAfterId,
    results,
  };
}

async function backfillMirrorParallel(context: IngestContext, options: MirrorBackfillOptions) {
  const mirrorRoot = process.env.GUTENBERG_MIRROR_ROOT;
  if (!mirrorRoot) {
    throw new Error("GUTENBERG_MIRROR_ROOT is required for mirror backfill.");
  }

  const checkpoint = options.checkpointPath ? await readCheckpoint(options.checkpointPath) : null;
  const startAfterId = options.startAfterId ?? checkpoint?.lastProcessedId ?? null;
  const allIds = await listMirrorIds(mirrorRoot);
  const existingRows = await context.db.query<{ gutenberg_id: string | number }>(
    `
      SELECT gutenberg_id::bigint::text AS gutenberg_id
      FROM works
      WHERE gutenberg_id IS NOT NULL
    `,
  );
  const existingIds = new Set(existingRows.rows.map((row) => String(row.gutenberg_id)));
  const firstGreaterIndex = startAfterId ? allIds.findIndex((id) => Number(id) > Number(startAfterId)) : -1;
  const startIndex = startAfterId ? (firstGreaterIndex >= 0 ? firstGreaterIndex : allIds.length) : 0;
  const candidateIds = allIds.slice(startIndex).filter((id) => !existingIds.has(id));
  const concurrency = Math.max(1, Number(options.concurrency ?? process.env.MIRROR_BACKFILL_CONCURRENCY ?? "4"));
  const results: Array<Record<string, unknown>> = [];
  const errors: Array<Record<string, unknown>> = [];
  let cursor = 0;
  let processed = 0;
  let inserted = 0;
  let skipped = 0;
  let lastProcessedId = startAfterId;

  async function worker() {
    while (inserted < options.limit && cursor < candidateIds.length) {
      const gutenbergId = candidateIds[cursor++];
      try {
        let result: Awaited<ReturnType<typeof ingestFromMirror>> | null = null;
        let lastError: unknown = null;

        for (let attempt = 0; attempt < 3; attempt += 1) {
          try {
            result = await ingestFromMirror(context, gutenbergId);
            break;
          } catch (error) {
            lastError = error;
            if (attempt < 2) {
              await sleep(1000 * 2 ** attempt);
            }
          }
        }

        if (!result) {
          throw lastError instanceof Error ? lastError : new Error(String(lastError));
        }

        processed += 1;
        lastProcessedId = gutenbergId;
        results.push(result);
        if ((result as { skipped?: boolean }).skipped) {
          skipped += 1;
        } else {
          inserted += 1;
        }
        if (options.checkpointPath) {
          await writeCheckpoint(options.checkpointPath, {
            lastProcessedId,
            processed,
            updatedAt: new Date().toISOString(),
          });
        }
        if (processed % 25 === 0 || inserted >= options.limit) {
          console.error(
            JSON.stringify({
              phase: "progress",
              processed,
              inserted,
              skipped,
              errors: errors.length,
              lastProcessedId,
            }),
          );
        }
      } catch (error) {
        processed += 1;
        lastProcessedId = gutenbergId;
        errors.push({
          gutenbergId,
          error: error instanceof Error ? error.message : String(error),
        });
        if (options.checkpointPath) {
          await writeCheckpoint(options.checkpointPath, {
            lastProcessedId,
            processed,
            updatedAt: new Date().toISOString(),
          });
        }
      }
    }
  }

  await Promise.all(Array.from({ length: concurrency }, () => worker()));

  return {
    mirrorRoot,
    startAfterId,
    concurrency,
    candidateCount: candidateIds.length,
    processed,
    inserted,
    skipped,
    errors,
    nextStartAfterId: lastProcessedId,
    results,
  };
}

async function buildContext(): Promise<IngestContext> {
  const databaseUrl = process.env.DATABASE_URL;
  const r2Bucket = process.env.R2_BUCKET_NAME;
  const r2Endpoint = process.env.R2_ENDPOINT;
  const r2AccessKeyId = process.env.R2_ACCESS_KEY_ID;
  const r2SecretAccessKey = process.env.R2_SECRET_ACCESS_KEY;

  if (!databaseUrl || !r2Bucket || !r2Endpoint || !r2AccessKeyId || !r2SecretAccessKey) {
    throw new Error("DATABASE_URL, R2_BUCKET_NAME, R2_ENDPOINT, R2_ACCESS_KEY_ID, and R2_SECRET_ACCESS_KEY are required.");
  }

  return {
    db: createNeonDb(databaseUrl),
    r2Bucket,
    r2: new S3Client({
      region: "auto",
      endpoint: r2Endpoint,
      credentials: {
        accessKeyId: r2AccessKeyId,
        secretAccessKey: r2SecretAccessKey,
      },
    }),
  };
}

async function main() {
  const [command, ...args] = process.argv.slice(2);
  const context = await buildContext();

  try {
    if (command === "ingest-url") {
      const [gutenbergId, sourceUrl, ...titleParts] = args;
      if (!gutenbergId || !sourceUrl || titleParts.length === 0) {
        throw new Error("Usage: ingest-url <gutenbergId> <sourceUrl> <title>");
      }
      const result = await ingestUrl(context, gutenbergId, sourceUrl, titleParts.join(" "));
      console.log(JSON.stringify(result, null, 2));
      return;
    }

    if (command === "ingest-gutenberg") {
      const [gutenbergId, ...titleParts] = args;
      if (!gutenbergId) {
        throw new Error("Usage: ingest-gutenberg <gutenbergId> [title]");
      }
      const result = await ingestFromMirror(context, gutenbergId, titleParts.length ? titleParts.join(" ") : undefined);
      console.log(JSON.stringify(result, null, 2));
      return;
    }

    if (command === "run-once") {
      const result = await backfillMirror(context, {
        limit: Number(process.env.MIRROR_BATCH_SIZE ?? "25"),
        checkpointPath: process.env.MIRROR_CHECKPOINT_PATH ?? ".alphabook/ingest-checkpoint.json",
      });
      console.log(JSON.stringify(result, null, 2));
      return;
    }

    if (command === "backfill-mirror") {
      const [startAfterId, limitValue] = args;
      const result = await backfillMirror(context, {
        startAfterId: startAfterId && startAfterId !== "-" ? startAfterId : null,
        limit: Number(limitValue ?? process.env.MIRROR_BATCH_SIZE ?? "100"),
        checkpointPath: process.env.MIRROR_CHECKPOINT_PATH ?? ".alphabook/ingest-checkpoint.json",
      });
      console.log(JSON.stringify(result, null, 2));
      return;
    }

    if (command === "backfill-mirror-parallel") {
      const [startAfterId, limitValue, concurrencyValue] = args;
      const result = await backfillMirrorParallel(context, {
        startAfterId: startAfterId && startAfterId !== "-" ? startAfterId : null,
        limit: Number(limitValue ?? process.env.MIRROR_BATCH_SIZE ?? "100"),
        checkpointPath: process.env.MIRROR_CHECKPOINT_PATH ?? ".alphabook/ingest-checkpoint.json",
        concurrency: Number(concurrencyValue ?? process.env.MIRROR_BACKFILL_CONCURRENCY ?? "4"),
      });
      console.log(JSON.stringify(result, null, 2));
      return;
    }

    if (command === "backfill-book-html") {
      const [startAfterId, limitValue, concurrencyValue] = args;
      const result = await backfillBookHtml(context, {
        startAfterId: startAfterId && startAfterId !== "-" ? startAfterId : null,
        limit: Number(limitValue ?? process.env.BOOK_HTML_BATCH_SIZE ?? "100"),
        concurrency: Number(concurrencyValue ?? process.env.BOOK_HTML_BACKFILL_CONCURRENCY ?? "8"),
      });
      console.log(JSON.stringify(result, null, 2));
      return;
    }

    if (command === "rebuild-book-html") {
      const [startAfterId, limitValue, concurrencyValue] = args;
      const result = await rebuildBookHtml(context, {
        startAfterId: startAfterId && startAfterId !== "-" ? startAfterId : null,
        limit: Number(limitValue ?? process.env.BOOK_HTML_BATCH_SIZE ?? "100"),
        concurrency: Number(concurrencyValue ?? process.env.BOOK_HTML_REBUILD_CONCURRENCY ?? "8"),
      });
      console.log(JSON.stringify(result, null, 2));
      return;
    }

    if (command === "delete-gutenberg") {
      if (args.length === 0) {
        throw new Error("Usage: delete-gutenberg <gutenbergId...>");
      }
      const result = await deleteGutenbergWorks(context, args);
      console.log(JSON.stringify(result, null, 2));
      return;
    }

    console.log("Commands:");
    console.log("  ingest-url <gutenbergId> <sourceUrl> <title>");
    console.log("  ingest-gutenberg <gutenbergId> [title]");
    console.log("  backfill-mirror [startAfterId|-] [limit]");
    console.log("  backfill-mirror-parallel [startAfterId|-] [limit] [concurrency]");
    console.log("  backfill-book-html [startAfterId|-] [limit] [concurrency]");
    console.log("  rebuild-book-html [startAfterId|-] [limit] [concurrency]");
    console.log("  delete-gutenberg <gutenbergId...>");
    console.log("  run-once");
  } finally {
    await context.db.end();
    context.r2.destroy();
  }
}

main()
  .then(() => {
    process.exit(0);
  })
  .catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  });
