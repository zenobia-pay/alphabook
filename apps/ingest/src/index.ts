import process from "node:process";
import crypto from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

import { DeleteObjectsCommand, S3Client, PutObjectCommand } from "@aws-sdk/client-s3";
import { createNeonDb } from "@alphabook/db";
import { R2_PREFIXES } from "@alphabook/shared";

import { listMirrorIds, resolveMirrorSource } from "./mirror";

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
  sourceUrl?: string;
  sourcePath?: string;
  metadata?: Record<string, unknown>;
}

interface MirrorBackfillOptions {
  startAfterId?: string | null;
  limit: number;
  checkpointPath?: string | null;
}

interface MirrorBackfillCheckpoint {
  lastProcessedId: string | null;
  processed: number;
  updatedAt: string;
}

function stripGutenbergBoilerplate(text: string): string {
  const startMarker = "*** START OF";
  const endMarker = "*** END OF";
  const startIndex = text.indexOf(startMarker);
  const endIndex = text.indexOf(endMarker);
  const withoutHeader = startIndex >= 0 ? text.slice(startIndex) : text;
  return (endIndex >= 0 ? withoutHeader.slice(0, endIndex) : withoutHeader).trim();
}

function normalizeText(input: string): string {
  return input
    .replace(/\r\n/g, "\n")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function chunkText(text: string, targetSize = 1400): string[] {
  const paragraphs = text.split(/\n{2,}/).map((chunk) => chunk.trim()).filter(Boolean);
  const chunks: string[] = [];
  let buffer = "";
  for (const paragraph of paragraphs) {
    if ((buffer + "\n\n" + paragraph).length > targetSize && buffer) {
      chunks.push(buffer);
      buffer = paragraph;
      continue;
    }
    buffer = buffer ? `${buffer}\n\n${paragraph}` : paragraph;
  }
  if (buffer) {
    chunks.push(buffer);
  }
  return chunks;
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
    const response = await fetch("https://api.openai.com/v1/embeddings", {
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
    if (!response.ok) {
      throw new Error(`Embedding request failed: ${await response.text()}`);
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
  const cleanText = normalizeText(stripGutenbergBoilerplate(source.rawText));
  const chunks = chunkText(cleanText);
  const chunkEmbeddings = await embedChunks(chunks);
  const authors = uniqueStrings(source.authors ?? []);
  const subjects = uniqueStrings(source.subjects ?? []);

  const rawKey = R2_PREFIXES.rawText(source.gutenbergId);
  const metadataKey = R2_PREFIXES.rawMetadata(source.gutenbergId);
  const cleanKey = R2_PREFIXES.cleanText(source.gutenbergId);
  const chunksKey = R2_PREFIXES.chunks(source.gutenbergId);
  const proposedWorkId = crypto.randomUUID();
  const metadataPayload = {
    gutenbergId: source.gutenbergId,
    title: source.title,
    authors,
    subjects,
    language: source.language ?? null,
    releaseDate: source.releaseDate ?? null,
    rightsStatus: source.rightsStatus ?? "public_domain",
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
      null,
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
  ]);

  await context.db.query(
    `
      INSERT INTO work_files (id, work_id, kind, r2_key, metadata_json)
      VALUES
        ($1::uuid, $2::uuid, 'raw', $3, '{}'::jsonb),
        ($4::uuid, $2::uuid, 'metadata', $5, '{}'::jsonb),
        ($6::uuid, $2::uuid, 'clean', $7, '{}'::jsonb),
        ($8::uuid, $2::uuid, 'chunks', $9, '{}'::jsonb)
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
    sourcePath: source.sourcePath,
    metadata: {
      source: "local-mirror",
      mirrorRoot,
      metadataPath: source.metadataPath,
      format: source.format,
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
      R2_PREFIXES.rawText(id),
      R2_PREFIXES.rawMetadata(id),
      R2_PREFIXES.cleanText(id),
      R2_PREFIXES.chunks(id),
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

  for (const gutenbergId of selectedIds) {
    const result = await ingestFromMirror(context, gutenbergId);
    results.push(result);
    if (options.checkpointPath) {
      await writeCheckpoint(options.checkpointPath, {
        lastProcessedId: gutenbergId,
        processed: (checkpoint?.processed ?? 0) + results.length,
        updatedAt: new Date().toISOString(),
      });
    }
  }

  return {
    mirrorRoot,
    startAfterId,
    processed: results.length,
    nextStartAfterId: results.length > 0 ? selectedIds[selectedIds.length - 1] : startAfterId,
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
