import type { DbClient } from "@alphabook/db";
import type {
  CorpusDocumentRecord,
  CorpusFileRecord,
} from "@alphabook/platform";

import type { DocumentTextRecord, WorkFileKind } from "./store";

function normalizeExternalId(value: number | string | null): number | string | null {
  if (value === null || value === undefined) {
    return null;
  }
  if (typeof value === "number") {
    return value;
  }
  if (/^\d+$/u.test(value)) {
    return Number(value);
  }
  return value;
}

function mapRowToDocument(row: {
  id: string;
  gutenberg_id: number | string | null;
  title: string;
  language: string | null;
  release_date: string | null;
  rights_status: string | null;
  summary: string | null;
  metadata_json: Record<string, unknown>;
  authors: string[];
  subjects: string[];
  score?: number;
}): CorpusDocumentRecord {
  return {
    id: row.id,
    externalId: normalizeExternalId(row.gutenberg_id),
    title: row.title,
    language: row.language,
    publishedAt: row.release_date,
    rightsStatus: row.rights_status,
    summary: row.summary,
    contributors: row.authors ?? [],
    subjects: row.subjects ?? [],
    metadata: row.metadata_json ?? {},
    score: row.score,
  };
}

export class NeonCorpusDbRepository {
  constructor(private readonly db: DbClient) {}

  async countDocuments(): Promise<number> {
    const result = await this.db.query<{ count: string }>("SELECT COUNT(*)::text AS count FROM works");
    return Number.parseInt(result.rows[0]?.count ?? "0", 10) || 0;
  }

  async listDocuments(offset = 0, limit = 50): Promise<CorpusDocumentRecord[]> {
    const result = await this.db.query<{
      id: string;
      gutenberg_id: number | string | null;
      title: string;
      metadata_json: Record<string, unknown>;
      language: string | null;
      release_date: string | null;
      rights_status: string | null;
      summary: string | null;
      authors: string[];
      subjects: string[];
      score: number;
    }>(
      `
        SELECT
          w.id,
          w.gutenberg_id,
          w.title,
          w.metadata_json,
          w.language,
          w.release_date::text,
          w.rights_status,
          w.summary,
          ARRAY_REMOVE(ARRAY_AGG(DISTINCT a.name), NULL) AS authors,
          ARRAY_REMOVE(ARRAY_AGG(DISTINCT s.label), NULL) AS subjects,
          0::float AS score
        FROM works w
        LEFT JOIN work_authors wa ON wa.work_id = w.id
        LEFT JOIN authors a ON a.id = wa.author_id
        LEFT JOIN work_subjects ws ON ws.work_id = w.id
        LEFT JOIN subjects s ON s.id = ws.subject_id
        GROUP BY w.id, w.gutenberg_id, w.title, w.metadata_json, w.language, w.release_date, w.rights_status, w.summary
        ORDER BY w.release_date DESC NULLS LAST, w.title ASC
        OFFSET $1
        LIMIT $2
      `,
      [offset, limit],
    );
    return result.rows.map(mapRowToDocument);
  }

  async getDocumentById(documentId: string): Promise<CorpusDocumentRecord | null> {
    const documents = await this.getDocumentMetadata([documentId]);
    return documents[0] ?? null;
  }

  async getDocumentMetadata(documentIds: string[]): Promise<CorpusDocumentRecord[]> {
    const result = await this.db.query<{
      id: string;
      gutenberg_id: number | string | null;
      title: string;
      metadata_json: Record<string, unknown>;
      language: string | null;
      release_date: string | null;
      rights_status: string | null;
      summary: string | null;
      authors: string[];
      subjects: string[];
      score: number;
    }>(
      `
        SELECT
          w.id,
          w.gutenberg_id,
          w.title,
          w.metadata_json,
          w.language,
          w.release_date::text,
          w.rights_status,
          w.summary,
          ARRAY_REMOVE(ARRAY_AGG(DISTINCT a.name), NULL) AS authors,
          ARRAY_REMOVE(ARRAY_AGG(DISTINCT s.label), NULL) AS subjects,
          0::float AS score
        FROM works w
        LEFT JOIN work_authors wa ON wa.work_id = w.id
        LEFT JOIN authors a ON a.id = wa.author_id
        LEFT JOIN work_subjects ws ON ws.work_id = w.id
        LEFT JOIN subjects s ON s.id = ws.subject_id
        WHERE w.id = ANY($1::uuid[])
        GROUP BY w.id, w.gutenberg_id, w.title, w.metadata_json, w.language, w.release_date, w.rights_status, w.summary
        ORDER BY w.title ASC
      `,
      [documentIds],
    );
    return result.rows.map(mapRowToDocument);
  }

  async getDocumentFiles(documentIds: string[], kinds?: WorkFileKind[]): Promise<CorpusFileRecord[]> {
    const result = await this.db.query<{
      work_id: string;
      kind: WorkFileKind;
      r2_key: string;
      byte_size: number | null;
      metadata_json: Record<string, unknown>;
    }>(
      `
        SELECT work_id, kind, r2_key, byte_size, metadata_json
        FROM work_files
        WHERE work_id = ANY($1::uuid[])
          AND ($2::text[] IS NULL OR kind = ANY($2::text[]))
        ORDER BY work_id ASC, kind ASC
      `,
      [documentIds, kinds?.length ? kinds : null],
    );
    return result.rows.map((row) => ({
      documentId: row.work_id,
      kind: row.kind,
      r2Key: row.r2_key,
      byteSize: row.byte_size,
      metadata: row.metadata_json,
    }));
  }

  async getDocumentTextFile(documentId: string): Promise<DocumentTextRecord | null> {
    const result = await this.db.query<{ work_id: string; r2_key: string | null }>(
      `
        SELECT work_id, r2_key
        FROM work_files
        WHERE work_id = $1::uuid AND kind = 'clean'
        LIMIT 1
      `,
      [documentId],
    );
    const row = result.rows[0];
    return row ? { documentId: row.work_id, r2Key: row.r2_key } : null;
  }
}
