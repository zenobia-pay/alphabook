export interface CorpusWorkspaceDocument {
  documentId: string;
  title?: string;
  contributors?: string[];
  language?: string | null;
  publishedAt?: string | null;
  rightsStatus?: string | null;
  summary?: string | null;
  subjects?: string[];
  cleanTextKey?: string;
  chunksKey?: string;
  metadata?: Record<string, unknown>;
}

export interface CorpusWorkspaceFile {
  documentId: string;
  kind: string;
  r2Key: string;
  destinationPath: string;
  byteSize?: number | null;
  metadata?: Record<string, unknown>;
}

export interface CorpusWorkspaceChunk {
  id: string;
  documentId: string;
  chunkIndex: number;
  text: string;
  excerpt: string;
  r2Key?: string | null;
  metadata?: Record<string, unknown>;
}

export interface CorpusWorkspaceManifest {
  runtimeId: string;
  sessionId: string;
  documents: CorpusWorkspaceDocument[];
  dataSchema?: Record<string, unknown>;
  fileCatalog?: CorpusWorkspaceFile[];
  selectedChunkIds: string[];
  selectedChunks?: CorpusWorkspaceChunk[];
  taskContext: Record<string, unknown>;
}

type LegacyLikeWork = {
  workId?: string;
  title?: string;
  authors?: string[];
  language?: string | null;
  releaseDate?: string | null;
  rightsStatus?: string | null;
  summary?: string | null;
  subjects?: string[];
  cleanTextKey?: string;
  chunksKey?: string;
};

type LegacyLikeChunk = {
  id: string;
  workId?: string;
  chunkIndex: number;
  text: string;
  excerpt: string;
  r2Key?: string | null;
};

type LegacyLikeFile = {
  workId?: string;
  kind: string;
  r2Key: string;
  destinationPath: string;
  byteSize?: number | null;
};

export function normalizeWorkspaceDocuments(input: {
  documents?: CorpusWorkspaceDocument[];
  works?: LegacyLikeWork[];
}): CorpusWorkspaceDocument[] {
  if (Array.isArray(input.documents) && input.documents.length > 0) {
    return input.documents;
  }
  return (input.works ?? []).map((work) => ({
    documentId: String(work.workId ?? ""),
    title: work.title,
    contributors: work.authors ?? [],
    language: work.language ?? null,
    publishedAt: work.releaseDate ?? null,
    rightsStatus: work.rightsStatus ?? null,
    summary: work.summary ?? null,
    subjects: work.subjects ?? [],
    cleanTextKey: work.cleanTextKey,
    chunksKey: work.chunksKey,
  }));
}

export function normalizeWorkspaceFileCatalog(input: {
  fileCatalog?: Array<CorpusWorkspaceFile | LegacyLikeFile>;
}): CorpusWorkspaceFile[] {
  return (input.fileCatalog ?? []).map((file) => ({
    documentId: "documentId" in file && typeof file.documentId === "string"
      ? file.documentId
      : String((file as LegacyLikeFile).workId ?? ""),
    kind: file.kind,
    r2Key: file.r2Key,
    destinationPath: file.destinationPath,
    byteSize: file.byteSize ?? null,
    metadata: "metadata" in file && file.metadata && typeof file.metadata === "object"
      ? file.metadata as Record<string, unknown>
      : undefined,
  }));
}

export function normalizeWorkspaceChunks(input: {
  selectedChunks?: Array<CorpusWorkspaceChunk | LegacyLikeChunk>;
}): CorpusWorkspaceChunk[] {
  return (input.selectedChunks ?? []).map((chunk) => ({
    id: chunk.id,
    documentId: "documentId" in chunk && typeof chunk.documentId === "string"
      ? chunk.documentId
      : String((chunk as LegacyLikeChunk).workId ?? ""),
    chunkIndex: chunk.chunkIndex,
    text: chunk.text,
    excerpt: chunk.excerpt,
    r2Key: chunk.r2Key ?? null,
    metadata: "metadata" in chunk && chunk.metadata && typeof chunk.metadata === "object"
      ? chunk.metadata as Record<string, unknown>
      : undefined,
  }));
}

export function withLegacyWorkAliases(manifest: CorpusWorkspaceManifest) {
  return {
    ...manifest,
    works: manifest.documents.map((document) => ({
      workId: document.documentId,
      title: document.title,
      authors: document.contributors ?? [],
      language: document.language ?? null,
      releaseDate: document.publishedAt ?? null,
      rightsStatus: document.rightsStatus ?? null,
      summary: document.summary ?? null,
      subjects: document.subjects ?? [],
      cleanTextKey: document.cleanTextKey,
      chunksKey: document.chunksKey,
    })),
    fileCatalog: (manifest.fileCatalog ?? []).map((file) => ({
      ...file,
      workId: file.documentId,
    })),
    selectedChunks: (manifest.selectedChunks ?? []).map((chunk) => ({
      ...chunk,
      workId: chunk.documentId,
    })),
  };
}
