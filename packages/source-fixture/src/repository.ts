import type {
  CorpusChunkRecord,
  CorpusDocumentRecord,
  CorpusFileRecord,
  CorpusRepository,
} from "@alphabook/platform";

import { fixtureCorpusAdapter, fixtureDocuments } from "./index";

const fixtureDocumentText: Record<string, string> = {
  "memo-1": "SOURCE: Incident memo\n\nA database failover caused elevated latency. The operations team documented mitigations and next steps.",
  "report-1": "SOURCE: Reliability report\n\nQuarterly service reliability improved. Error budgets stabilized and follow-up actions focused on incident prevention.",
};

function cloneDocument(document: typeof fixtureDocuments[number]): CorpusDocumentRecord {
  return {
    ...document,
    contributors: [...document.contributors],
    subjects: [...document.subjects],
    metadata: { ...(document.metadata ?? {}) },
  };
}

const fixtureDocumentFiles: CorpusFileRecord[] = fixtureDocuments.flatMap((document) => {
  const text = fixtureCorpusAdapter.text.normalizeText(
    fixtureCorpusAdapter.text.stripSourceBoilerplate(fixtureDocumentText[document.id] ?? ""),
  );
  return [
    {
      documentId: document.id,
      kind: "clean",
      r2Key: fixtureCorpusAdapter.artifactKeys.cleanText(document.id),
      byteSize: text.length,
      metadata: {},
    },
    {
      documentId: document.id,
      kind: "chunks",
      r2Key: fixtureCorpusAdapter.artifactKeys.chunks(document.id),
      byteSize: text.length,
      metadata: {},
    },
    {
      documentId: document.id,
      kind: "document_html",
      r2Key: fixtureCorpusAdapter.artifactKeys.renderedDocument?.(document.id) ?? "",
      byteSize: null,
      metadata: {},
    },
  ];
});

const fixtureChunks: CorpusChunkRecord[] = fixtureDocuments.flatMap((document) => {
  const stripped = fixtureCorpusAdapter.text.stripSourceBoilerplate(fixtureDocumentText[document.id] ?? "");
  const normalized = fixtureCorpusAdapter.text.normalizeText(stripped);
  return fixtureCorpusAdapter.text.chunkText(normalized).map((text, index) => ({
    id: `${document.id}-chunk-${index + 1}`,
    documentId: document.id,
    chunkIndex: index,
    text,
    excerpt: text.slice(0, 180),
    r2Key: fixtureCorpusAdapter.artifactKeys.chunks(document.id),
    score: 0,
  }));
});

function lexicalScore(query: string, haystack: string) {
  const tokens = query.toLowerCase().split(/[^a-z0-9]+/u).filter((token) => token.length >= 3);
  return tokens.reduce((total, token) => total + (haystack.includes(token) ? 1 : 0), 0);
}

function toHaystack(document: {
  title: string;
  summary?: string | null;
  contributors?: readonly string[];
  subjects?: readonly string[];
  metadata?: Record<string, unknown>;
}) {
  return [
    document.title,
    document.summary ?? "",
    ...(document.contributors ?? []),
    ...(document.subjects ?? []),
    JSON.stringify(document.metadata ?? {}),
  ].join(" ").toLowerCase();
}

export function createFixtureCorpusRepository(): CorpusRepository {
  return {
    async countDocuments() {
      return fixtureDocuments.length;
    },
    async listDocuments(offset = 0, limit = 50) {
      return fixtureDocuments.slice(offset, offset + limit).map(cloneDocument);
    },
    async getDocumentById(documentId) {
      const document = fixtureDocuments.find((candidate) => candidate.id === documentId);
      return document ? cloneDocument(document) : null;
    },
    async searchDocuments(query) {
      const normalizedQuery = fixtureCorpusAdapter.hooks?.normalizeQuery?.(query).normalizedQuery ?? query;
      const expandedTerms = fixtureCorpusAdapter.hooks?.expandQueryTerms?.({
        query: normalizedQuery,
        mode: "metadata",
      }) ?? [];
      const effectiveQuery = [normalizedQuery, ...expandedTerms].join(" ").trim();
      return fixtureDocuments
        .map((document) => {
          const cloned = cloneDocument(document);
          const score = lexicalScore(effectiveQuery, toHaystack(document)) + (
            fixtureCorpusAdapter.hooks?.scoreDocumentMetadata?.({
              query: effectiveQuery,
              document: cloned,
              metadata: cloned.metadata ?? {},
            }) ?? 0
          );
          return { ...cloned, score };
        })
        .filter((document) => (document.score ?? 0) > 0)
        .sort((left, right) => (right.score ?? 0) - (left.score ?? 0))
        .map((document) => ({ ...document, contributors: [...(document.contributors ?? [])], subjects: [...(document.subjects ?? [])] }));
    },
    async getDocumentMetadata(documentIds) {
      const wanted = new Set(documentIds);
      return fixtureDocuments.filter((document) => wanted.has(document.id)).map(cloneDocument);
    },
    async getRelevantChunks(query, documentIds, limit = 8) {
      const wanted = documentIds?.length ? new Set(documentIds) : null;
      return fixtureChunks
        .filter((chunk) => !wanted || wanted.has(chunk.documentId))
        .map((chunk) => ({
          ...chunk,
          score: lexicalScore(query, chunk.text.toLowerCase()),
        }))
        .filter((chunk) => (chunk.score ?? 0) > 0)
        .sort((left, right) => (right.score ?? 0) - (left.score ?? 0))
        .slice(0, limit);
    },
    async getDocumentFiles(documentIds, kinds) {
      const wantedDocuments = new Set(documentIds);
      const wantedKinds = kinds?.length ? new Set(kinds) : null;
      return fixtureDocumentFiles.filter((file) =>
        wantedDocuments.has(file.documentId) && (!wantedKinds || wantedKinds.has(file.kind)),
      );
    },
    async getDocumentTextFile(documentId) {
      const document = fixtureDocuments.find((candidate) => candidate.id === documentId);
      return document
        ? {
            documentId,
            r2Key: fixtureCorpusAdapter.artifactKeys.cleanText(documentId),
          }
        : null;
    },
    async getChunksByIds(chunkIds) {
      const wanted = new Set(chunkIds);
      return fixtureChunks.filter((chunk) => wanted.has(chunk.id));
    },
  };
}
