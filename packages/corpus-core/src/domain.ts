export interface CorpusDocument {
  id: string;
  externalId?: string | number | null;
  title: string;
  subtitle?: string | null;
  summary?: string | null;
  language?: string | null;
  publishedAt?: string | null;
  rightsStatus?: string | null;
  contributors?: string[];
  subjects?: string[];
  metadata?: Record<string, unknown>;
}

export interface CorpusFile {
  documentId: string;
  kind: string;
  r2Key: string;
  byteSize?: number | null;
  metadata?: Record<string, unknown>;
}

export interface CorpusChunk {
  id: string;
  documentId: string;
  chunkIndex: number;
  text: string;
  excerpt: string;
  r2Key?: string | null;
  metadata?: Record<string, unknown>;
}

export interface CorpusArtifactKeyBuilder {
  rawText(id: string): string;
  rawMetadata(id: string): string;
  coverImage?(id: string, extension?: string): string;
  cleanText(id: string): string;
  chunks(id: string): string;
  renderedDocument?(id: string): string;
  renderedManifest?(id: string): string;
  renderedPage?(id: string, pageNumber: number): string;
}

export interface CorpusAdapterTextOps {
  stripSourceBoilerplate(text: string): string;
  normalizeText(input: string): string;
  chunkText(text: string, targetSize?: number): string[];
}

export interface CorpusAdapter {
  id: string;
  displayName: string;
  description: string;
  workspaceSchema?: Record<string, unknown>;
  artifactKeys: CorpusArtifactKeyBuilder;
  text: CorpusAdapterTextOps;
}
