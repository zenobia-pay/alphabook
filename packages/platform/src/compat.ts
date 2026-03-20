import type {
  DocumentDetail,
  DocumentSource,
  DocumentSummary,
  PlatformCitation,
} from "./contracts";

export interface LegacyWorkSummaryLike {
  id: string;
  gutenbergId?: number | null;
  title: string;
  subtitle?: string | null;
  coverImageUrl?: string | null;
  hasCoverImage?: boolean;
  language: string | null;
  releaseDate: string | null;
  rightsStatus: string | null;
  summary: string | null;
  publisher?: string | null;
  authors?: string[];
  subjects?: string[];
  score?: number;
  metadata?: Record<string, unknown>;
}

export interface LegacyWorkDetailLike extends LegacyWorkSummaryLike {
  metadata: Record<string, unknown>;
}

export interface LegacyWorkSourceLike {
  format: "html" | "text";
  content: string;
  r2Key: string | null;
  sourcePath: string | null;
  metadataPath: string | null;
}

export interface LegacyCitationLike {
  workId: string;
  chunkId?: string;
  label: string;
  excerpt: string;
  r2Key?: string;
}

export function workSummaryToDocumentSummary(work: LegacyWorkSummaryLike): DocumentSummary {
  return {
    id: work.id,
    externalId: work.gutenbergId ?? null,
    title: work.title,
    subtitle: work.subtitle ?? null,
    coverImageUrl: work.coverImageUrl ?? null,
    hasCoverImage: work.hasCoverImage,
    language: work.language,
    publishedAt: work.releaseDate,
    rightsStatus: work.rightsStatus,
    summary: work.summary,
    publisher: work.publisher ?? null,
    contributors: work.authors ?? [],
    subjects: work.subjects ?? [],
    score: work.score,
    metadata: work.metadata ?? {},
  };
}

export function workDetailToDocumentDetail(work: LegacyWorkDetailLike): DocumentDetail {
  return {
    ...workSummaryToDocumentSummary(work),
    metadata: work.metadata ?? {},
  };
}

export function documentSummaryToWorkSummary(document: DocumentSummary): LegacyWorkSummaryLike {
  const normalizedExternalId = document.externalId;
  return {
    id: document.id,
    gutenbergId: typeof normalizedExternalId === "number"
      ? normalizedExternalId
      : typeof normalizedExternalId === "string" && /^\d+$/.test(normalizedExternalId)
        ? Number(normalizedExternalId)
        : null,
    title: document.title,
    subtitle: document.subtitle ?? null,
    coverImageUrl: document.coverImageUrl ?? null,
    hasCoverImage: document.hasCoverImage,
    language: document.language,
    releaseDate: document.publishedAt,
    rightsStatus: document.rightsStatus,
    summary: document.summary,
    publisher: document.publisher ?? null,
    authors: document.contributors ?? [],
    subjects: document.subjects ?? [],
    score: document.score,
    metadata: document.metadata ?? {},
  };
}

export function documentSourceToWorkSource(source: DocumentSource): LegacyWorkSourceLike {
  return {
    format: source.format,
    content: source.content,
    r2Key: source.r2Key,
    sourcePath: source.sourcePath,
    metadataPath: source.metadataPath,
  };
}

export function workSourceToDocumentSource(source: LegacyWorkSourceLike): DocumentSource {
  return {
    format: source.format,
    content: source.content,
    r2Key: source.r2Key,
    sourcePath: source.sourcePath,
    metadataPath: source.metadataPath,
  };
}

export function citationToPlatformCitation(citation: LegacyCitationLike): PlatformCitation {
  return {
    documentId: citation.workId,
    chunkId: citation.chunkId,
    label: citation.label,
    excerpt: citation.excerpt,
    r2Key: citation.r2Key,
  };
}

export function platformCitationToLegacyCitation(citation: PlatformCitation): LegacyCitationLike {
  return {
    workId: citation.documentId,
    chunkId: citation.chunkId,
    label: citation.label,
    excerpt: citation.excerpt,
    r2Key: citation.r2Key,
  };
}
