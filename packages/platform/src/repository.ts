import type {
  CorpusChunk,
  CorpusDocument,
  CorpusFile,
} from "@alphabook/corpus-core";

export interface CorpusDocumentRecord extends CorpusDocument {}

export interface CorpusChunkRecord extends CorpusChunk {
  score?: number;
}

export interface CorpusFileRecord extends CorpusFile {}

export interface CorpusSourceRecord {
  format: "html" | "text";
  content: string;
  r2Key: string | null;
  sourcePath: string | null;
  metadataPath: string | null;
}

export interface CorpusRepository {
  countDocuments(): Promise<number>;
  listDocuments(offset?: number, limit?: number): Promise<CorpusDocumentRecord[]>;
  getDocumentById(documentId: string): Promise<CorpusDocumentRecord | null>;
  searchDocuments(query: string, filters?: Record<string, unknown>): Promise<CorpusDocumentRecord[]>;
  getDocumentMetadata(documentIds: string[]): Promise<CorpusDocumentRecord[]>;
  getRelevantChunks(
    query: string,
    documentIds?: string[],
    limit?: number,
    embedding?: number[],
    filters?: Record<string, unknown>,
  ): Promise<CorpusChunkRecord[]>;
  getDocumentFiles(documentIds: string[], kinds?: string[]): Promise<CorpusFileRecord[]>;
  getDocumentTextFile(documentId: string): Promise<{ documentId: string; r2Key: string | null } | null>;
  getChunksByIds(chunkIds: string[]): Promise<CorpusChunkRecord[]>;
}
