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
  score?: number;
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

export interface CorpusAdapterCapabilitySet {
  renderedDocuments?: boolean;
  coverImages?: boolean;
  staticContent?: {
    routePrefix?: string;
    externalIdPattern?: RegExp;
  };
}

export interface CorpusQueryNormalizationResult {
  normalizedQuery: string;
  filters?: Record<string, unknown>;
}

export interface CorpusFacetSummary {
  label: string;
  value: string;
  score?: number;
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

export interface CorpusAdapterHooks {
  normalizeQuery?(query: string, filters?: Record<string, unknown>): CorpusQueryNormalizationResult;
  expandQueryTerms?(input: {
    query: string;
    mode: "search" | "metadata" | "passage" | "scope";
    filters?: Record<string, unknown>;
  }): string[] | null;
  summarizeFacets?(metadata: Record<string, unknown>): CorpusFacetSummary[];
  scoreDocumentMetadata?(input: {
    query: string;
    document: CorpusDocument;
    metadata: Record<string, unknown>;
  }): number | null;
  acceptMetadataResults?(input: {
    query: string;
    limit: number;
    documents: CorpusDocument[];
  }): boolean | null;
  recommendedShardAxis?(input: {
    query: string;
    estimatedDocumentBreadth: number;
  }): "none" | "work_id_hash" | "author_initial" | "publication_year" | "retrieval_strategy" | null;
}

export interface CorpusAdapter {
  id: string;
  displayName: string;
  description: string;
  workspaceSchema?: Record<string, unknown>;
  capabilities?: CorpusAdapterCapabilitySet;
  artifactKeys: CorpusArtifactKeyBuilder;
  text: CorpusAdapterTextOps;
  hooks?: CorpusAdapterHooks;
}
