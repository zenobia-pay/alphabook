import type { CorpusAdapter } from "@alphabook/corpus-core";

export interface RenderedArtifactPage {
  pageNumber: number;
  html: string;
}

export interface RenderedArtifactBundle {
  landingHtml: string;
  manifestJson: string;
  pageFiles: RenderedArtifactPage[];
}

export interface CorpusIngestSourceInput {
  adapterId: string;
  externalId: string;
  legacyNumericId?: string | null;
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
  renderedArtifacts?: RenderedArtifactBundle | null;
}

export interface PreparedCorpusIngest {
  authors: string[];
  subjects: string[];
  cleanText: string;
  chunks: string[];
  rawKey: string;
  metadataKey: string;
  cleanKey: string;
  chunksKey: string;
  renderedDocumentKey: string | null;
  renderedManifestKey: string | null;
  metadataPayload: Record<string, unknown>;
  renderedArtifacts: RenderedArtifactBundle | null;
}

export interface PrepareCorpusIngestOptions {
  chunkTargetSize?: number;
}

function escapeHtml(value: string) {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll("\"", "&quot;")
    .replaceAll("'", "&#39;");
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

function createExcerpt(value: string, maxLength = 240) {
  const normalized = value.replace(/\s+/g, " ").trim();
  if (normalized.length <= maxLength) {
    return normalized;
  }
  return `${normalized.slice(0, maxLength - 1).trimEnd()}…`;
}

export function buildSimpleRenderedArtifactBundle(input: {
  externalId: string;
  title: string;
  authors: string[];
  summary?: string | null;
  cleanText: string;
}): RenderedArtifactBundle {
  const paragraphs = input.cleanText
    .split(/\n{2,}/u)
    .map((paragraph) => paragraph.trim())
    .filter(Boolean);
  const bodyHtml = paragraphs.map((paragraph) => `<p>${escapeHtml(paragraph)}</p>`).join("\n");
  const byline = input.authors.filter((author) => author.trim().length > 0).join(" · ");
  const landingHtml = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>${escapeHtml(input.title)}</title>
    <meta name="description" content="${escapeHtml(createExcerpt(input.summary ?? input.cleanText))}" />
    <meta name="robots" content="noindex,nofollow" />
  </head>
  <body>
    <main>
      <header>
        <h1>${escapeHtml(input.title)}</h1>
        ${byline ? `<p>${escapeHtml(byline)}</p>` : ""}
        ${input.summary ? `<p>${escapeHtml(input.summary)}</p>` : ""}
      </header>
      <article>
        ${bodyHtml}
      </article>
    </main>
  </body>
</html>`;
  return {
    landingHtml,
    manifestJson: JSON.stringify({
      externalId: input.externalId,
      title: input.title,
      pageCount: 1,
      pages: [{ pageNumber: 1, href: "./page-0001.html" }],
    }, null, 2),
    pageFiles: [{
      pageNumber: 1,
      html: landingHtml,
    }],
  };
}

export function prepareCorpusIngest(
  adapter: CorpusAdapter,
  source: CorpusIngestSourceInput,
  options: PrepareCorpusIngestOptions = {},
): PreparedCorpusIngest {
  const cleanText = adapter.text.normalizeText(
    adapter.text.stripSourceBoilerplate(source.rawText),
  );
  const chunks = adapter.text.chunkText(cleanText, options.chunkTargetSize);
  const authors = uniqueStrings(source.authors ?? []);
  const subjects = uniqueStrings(source.subjects ?? []);
  const rawKey = adapter.artifactKeys.rawText(source.externalId);
  const metadataKey = adapter.artifactKeys.rawMetadata(source.externalId);
  const cleanKey = adapter.artifactKeys.cleanText(source.externalId);
  const chunksKey = adapter.artifactKeys.chunks(source.externalId);
  const renderedDocumentKey = adapter.artifactKeys.renderedDocument?.(source.externalId) ?? null;
  const renderedManifestKey = adapter.artifactKeys.renderedManifest?.(source.externalId) ?? null;
  const metadataPayload = {
    corpusAdapterId: source.adapterId,
    externalId: source.externalId,
    legacyNumericId: source.legacyNumericId ?? null,
    title: source.title,
    authors,
    subjects,
    language: source.language ?? null,
    releaseDate: source.releaseDate ?? null,
    rightsStatus: source.rightsStatus ?? null,
    summary: source.summary ?? null,
    sourceUrl: source.sourceUrl ?? null,
    sourcePath: source.sourcePath ?? null,
    sourceFormat: source.sourceFormat ?? "text",
    ...source.metadata,
  };
  const renderedArtifacts = source.renderedArtifacts
    ?? (adapter.capabilities?.renderedDocuments
      ? buildSimpleRenderedArtifactBundle({
          externalId: source.externalId,
          title: source.title,
          authors,
          summary: source.summary ?? null,
          cleanText,
        })
      : null);
  return {
    authors,
    subjects,
    cleanText,
    chunks,
    rawKey,
    metadataKey,
    cleanKey,
    chunksKey,
    renderedDocumentKey,
    renderedManifestKey,
    metadataPayload,
    renderedArtifacts,
  };
}
