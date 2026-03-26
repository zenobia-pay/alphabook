import type { DbClient } from "@alphabook/db";
import type { CorpusDocumentRecord, CorpusFileRecord } from "@alphabook/platform";

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

function parseJsonArray(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value.map((entry) => String(entry));
  }
  if (typeof value !== "string" || !value.trim()) {
    return [];
  }
  try {
    const parsed = JSON.parse(value) as unknown;
    return Array.isArray(parsed)
      ? parsed.filter((entry): entry is string => typeof entry === "string" && entry.length > 0)
      : [];
  } catch {
    return [];
  }
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
  authors_json: string | null;
  subjects_json: string | null;
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
    contributors: parseJsonArray(row.authors_json),
    subjects: parseJsonArray(row.subjects_json),
    metadata: row.metadata_json ?? {},
    score: row.score,
  };
}

export class D1CorpusDbRepository {
  private readonly adapterId: string | null;

  constructor(private readonly db: DbClient, options: { adapterId?: string | null } = {}) {
    this.adapterId = options.adapterId ?? null;
  }

  private hasScopedCorpus() {
    return Boolean(this.adapterId && this.adapterId !== "gutenberg");
  }

  private adapterWorkClause(alias = "w") {
    if (!this.hasScopedCorpus()) {
      return "";
    }
    return ` AND COALESCE(json_extract(${alias}.metadata_json, '$.corpusAdapterId'), '') = '${this.adapterId}'`;
  }

  async countDocuments(): Promise<number> {
    const result = await this.db.query<{ count: string | number }>(
      `SELECT COUNT(*) AS count FROM works w WHERE 1 = 1 ${this.adapterWorkClause("w")}`,
    );
    return Number.parseInt(String(result.rows[0]?.count ?? "0"), 10) || 0;
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
      authors_json: string | null;
      subjects_json: string | null;
      score: number;
    }>(
      `
        SELECT
          w.id,
          w.gutenberg_id,
          w.title,
          w.metadata_json,
          w.language,
          w.release_date,
          w.rights_status,
          w.summary,
          json_group_array(DISTINCT a.name) AS authors_json,
          json_group_array(DISTINCT s.label) AS subjects_json,
          0 AS score
        FROM works w
        LEFT JOIN work_authors wa ON wa.work_id = w.id
        LEFT JOIN authors a ON a.id = wa.author_id
        LEFT JOIN work_subjects ws ON ws.work_id = w.id
        LEFT JOIN subjects s ON s.id = ws.subject_id
        WHERE 1 = 1 ${this.adapterWorkClause("w")}
        GROUP BY w.id, w.gutenberg_id, w.title, w.metadata_json, w.language, w.release_date, w.rights_status, w.summary
        ORDER BY CASE WHEN w.release_date IS NULL THEN 1 ELSE 0 END, w.release_date DESC, w.title ASC
        LIMIT $1 OFFSET $2
      `,
      [limit, offset],
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
      authors_json: string | null;
      subjects_json: string | null;
      score: number;
    }>(
      `
        SELECT
          w.id,
          w.gutenberg_id,
          w.title,
          w.metadata_json,
          w.language,
          w.release_date,
          w.rights_status,
          w.summary,
          json_group_array(DISTINCT a.name) AS authors_json,
          json_group_array(DISTINCT s.label) AS subjects_json,
          0 AS score
        FROM works w
        LEFT JOIN work_authors wa ON wa.work_id = w.id
        LEFT JOIN authors a ON a.id = wa.author_id
        LEFT JOIN work_subjects ws ON ws.work_id = w.id
        LEFT JOIN subjects s ON s.id = ws.subject_id
        WHERE w.id IN $1 ${this.adapterWorkClause("w")}
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
        WHERE work_id IN $1
          AND ($2 IS NULL OR kind IN $2)
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
        WHERE work_id = $1 AND kind = 'clean'
        LIMIT 1
      `,
      [documentId],
    );
    const row = result.rows[0];
    return row ? { documentId: row.work_id, r2Key: row.r2_key } : null;
  }
}
