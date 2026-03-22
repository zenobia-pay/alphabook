import type { CorpusAdapter } from "@alphabook/corpus-core";
import type {
  CorpusChunkRecord,
  CorpusDocumentRecord,
  CorpusFileRecord,
  CorpusRepository,
} from "@alphabook/platform";

export const supremeCourtCases = [
  {
    id: "brown-v-board-1954",
    externalId: "347-us-483",
    title: "Brown v. Board of Education",
    language: "en",
    rightsStatus: "public_domain",
    publishedAt: "1954-05-17",
    summary: "The Court held that racial segregation in public schools violates the Equal Protection Clause.",
    contributors: ["Earl Warren"],
    subjects: ["equal protection", "segregation", "education"],
    metadata: {
      citation: "347 U.S. 483",
      docketNumber: "1",
      term: "1954",
      decisionType: "majority",
    },
  },
  {
    id: "miranda-v-arizona-1966",
    externalId: "384-us-436",
    title: "Miranda v. Arizona",
    language: "en",
    rightsStatus: "public_domain",
    publishedAt: "1966-06-13",
    summary: "The Court required police to advise suspects of key constitutional rights before custodial interrogation.",
    contributors: ["Earl Warren"],
    subjects: ["criminal procedure", "self-incrimination", "police interrogation"],
    metadata: {
      citation: "384 U.S. 436",
      docketNumber: "759",
      term: "1966",
      decisionType: "majority",
    },
  },
  {
    id: "new-york-times-v-sullivan-1964",
    externalId: "376-us-254",
    title: "New York Times Co. v. Sullivan",
    language: "en",
    rightsStatus: "public_domain",
    publishedAt: "1964-03-09",
    summary: "The Court held that public officials must prove actual malice in certain defamation actions.",
    contributors: ["William J. Brennan Jr."],
    subjects: ["first amendment", "defamation", "press freedom"],
    metadata: {
      citation: "376 U.S. 254",
      docketNumber: "39",
      term: "1964",
      decisionType: "majority",
    },
  },
] as const;

export const supremeCourtCaseSources: Record<string, string> = {
  "brown-v-board-1954": [
    "Held: Separate educational facilities are inherently unequal.",
    "",
    "Segregation of white and colored children in public schools has a detrimental effect upon the colored children.",
    "",
    "We conclude that, in the field of public education, the doctrine of 'separate but equal' has no place.",
  ].join("\n"),
  "miranda-v-arizona-1966": [
    "The prosecution may not use statements stemming from custodial interrogation unless it demonstrates the use of procedural safeguards effective to secure the privilege against self-incrimination.",
    "",
    "The person must be warned that he has a right to remain silent.",
    "",
    "He must be warned that anything he says can be used against him in a court of law.",
  ].join("\n"),
  "new-york-times-v-sullivan-1964": [
    "The constitutional guarantees require a federal rule that prohibits a public official from recovering damages for a defamatory falsehood relating to his official conduct unless he proves that the statement was made with actual malice.",
    "",
    "Erroneous statement is inevitable in free debate, and it must be protected if the freedoms of expression are to have the breathing space that they need to survive.",
  ].join("\n"),
};

export const supremeCourtCorpusAdapter: CorpusAdapter = {
  id: "supreme_court",
  displayName: "Supreme Court Cases",
  description: "Adapter for Supreme Court opinions and related legal metadata.",
  capabilities: {
    renderedDocuments: true,
    staticContent: {
      routePrefix: "/case-content-static/",
      externalIdPattern: /^[a-z0-9.-]+$/u,
    },
  },
  artifactKeys: {
    rawText: (id) => `supreme-court/raw/${id}/raw.txt`,
    rawMetadata: (id) => `supreme-court/raw/${id}/metadata.json`,
    cleanText: (id) => `supreme-court/clean/${id}/clean.txt`,
    chunks: (id) => `supreme-court/clean/${id}/chunks.jsonl`,
    renderedDocument: (id) => `supreme-court/clean/${id}/case.html`,
    renderedManifest: (id) => `supreme-court/clean/${id}/manifest.json`,
    renderedPage: (id, pageNumber) => `supreme-court/clean/${id}/pages/page-${String(pageNumber).padStart(4, "0")}.html`,
  },
  text: {
    stripSourceBoilerplate: (text) => text.trim(),
    normalizeText: (text) => text.replace(/\r\n/g, "\n").trim(),
    chunkText: (text, targetSize = 1400) => {
      const normalized = text.trim();
      if (normalized.length <= targetSize) {
        return normalized ? [normalized] : [];
      }
      return normalized.split(/\n{2,}/u).filter(Boolean);
    },
  },
  hooks: {
    normalizeQuery(query, filters) {
      return {
        normalizedQuery: query
          .replace(/\bbooks?\b/giu, "cases")
          .replace(/\bnovels?\b/giu, "cases")
          .trim(),
        filters,
      };
    },
    expandQueryTerms(input) {
      const tokens = input.query.toLowerCase().split(/[^a-z0-9]+/u).filter((token) => token.length >= 3);
      const expanded = new Set(tokens);
      if (tokens.includes("segregation") || tokens.includes("school")) {
        expanded.add("equal");
        expanded.add("protection");
      }
      if (tokens.includes("police") || tokens.includes("interrogation")) {
        expanded.add("miranda");
        expanded.add("custodial");
      }
      if (tokens.includes("press") || tokens.includes("defamation")) {
        expanded.add("actual");
        expanded.add("malice");
      }
      return [...expanded];
    },
    summarizeFacets(metadata) {
      return [
        typeof metadata.term === "string" ? { label: "term", value: metadata.term } : null,
        typeof metadata.citation === "string" ? { label: "citation", value: metadata.citation } : null,
      ].filter((value): value is { label: string; value: string } => Boolean(value));
    },
    scoreDocumentMetadata({ query, document }) {
      const haystack = [
        document.title,
        document.summary ?? "",
        ...(document.subjects ?? []),
        JSON.stringify(document.metadata ?? {}),
      ].join(" ").toLowerCase();
      let score = 0;
      for (const token of query.toLowerCase().split(/[^a-z0-9]+/u).filter(Boolean)) {
        if (haystack.includes(token)) {
          score += 0.25;
        }
      }
      return score;
    },
    acceptMetadataResults(input) {
      return input.documents.length >= Math.min(input.limit, 3);
    },
    recommendedShardAxis() {
      return "publication_year";
    },
  },
};

function cloneCase(caseRecord: typeof supremeCourtCases[number]): CorpusDocumentRecord {
  return {
    ...caseRecord,
    contributors: [...caseRecord.contributors],
    subjects: [...caseRecord.subjects],
    metadata: { ...(caseRecord.metadata ?? {}) },
  };
}

const supremeCourtFiles: CorpusFileRecord[] = supremeCourtCases.flatMap((caseRecord) => {
  const text = supremeCourtCorpusAdapter.text.normalizeText(
    supremeCourtCorpusAdapter.text.stripSourceBoilerplate(supremeCourtCaseSources[caseRecord.id] ?? ""),
  );
  return [
    {
      documentId: caseRecord.id,
      kind: "clean",
      r2Key: supremeCourtCorpusAdapter.artifactKeys.cleanText(caseRecord.id),
      byteSize: text.length,
      metadata: {},
    },
    {
      documentId: caseRecord.id,
      kind: "chunks",
      r2Key: supremeCourtCorpusAdapter.artifactKeys.chunks(caseRecord.id),
      byteSize: text.length,
      metadata: {},
    },
    {
      documentId: caseRecord.id,
      kind: "document_html",
      r2Key: supremeCourtCorpusAdapter.artifactKeys.renderedDocument?.(caseRecord.id) ?? "",
      byteSize: null,
      metadata: {},
    },
  ];
});

const supremeCourtChunks: CorpusChunkRecord[] = supremeCourtCases.flatMap((caseRecord) => {
  const normalized = supremeCourtCorpusAdapter.text.normalizeText(
    supremeCourtCorpusAdapter.text.stripSourceBoilerplate(supremeCourtCaseSources[caseRecord.id] ?? ""),
  );
  return supremeCourtCorpusAdapter.text.chunkText(normalized).map((text, index) => ({
    id: `${caseRecord.id}-chunk-${index + 1}`,
    documentId: caseRecord.id,
    chunkIndex: index,
    text,
    excerpt: text.slice(0, 220),
    r2Key: supremeCourtCorpusAdapter.artifactKeys.chunks(caseRecord.id),
    score: 0,
  }));
});

function lexicalScore(query: string, haystack: string) {
  const tokens = query.toLowerCase().split(/[^a-z0-9]+/u).filter((token) => token.length >= 3);
  return tokens.reduce((total, token) => total + (haystack.includes(token) ? 1 : 0), 0);
}

function toHaystack(document: CorpusDocumentRecord) {
  return [
    document.title,
    document.summary ?? "",
    ...(document.contributors ?? []),
    ...(document.subjects ?? []),
    JSON.stringify(document.metadata ?? {}),
  ].join(" ").toLowerCase();
}

export function createSupremeCourtRepository(): CorpusRepository {
  return {
    async countDocuments() {
      return supremeCourtCases.length;
    },
    async listDocuments(offset = 0, limit = 50) {
      return supremeCourtCases.slice(offset, offset + limit).map(cloneCase);
    },
    async getDocumentById(documentId) {
      const found = supremeCourtCases.find((candidate) => candidate.id === documentId);
      return found ? cloneCase(found) : null;
    },
    async searchDocuments(query) {
      const normalizedQuery = supremeCourtCorpusAdapter.hooks?.normalizeQuery?.(query).normalizedQuery ?? query;
      const expandedTerms = supremeCourtCorpusAdapter.hooks?.expandQueryTerms?.({
        query: normalizedQuery,
        mode: "metadata",
      }) ?? [];
      const effectiveQuery = [normalizedQuery, ...expandedTerms].join(" ").trim();
      return supremeCourtCases
        .map((caseRecord) => {
          const cloned = cloneCase(caseRecord);
          const score = lexicalScore(effectiveQuery, toHaystack(cloned)) + (
            supremeCourtCorpusAdapter.hooks?.scoreDocumentMetadata?.({
              query: effectiveQuery,
              document: cloned,
              metadata: cloned.metadata ?? {},
            }) ?? 0
          );
          return { ...cloned, score };
        })
        .filter((document) => (document.score ?? 0) > 0)
        .sort((left, right) => (right.score ?? 0) - (left.score ?? 0));
    },
    async getDocumentMetadata(documentIds) {
      const wanted = new Set(documentIds);
      return supremeCourtCases.filter((candidate) => wanted.has(candidate.id)).map(cloneCase);
    },
    async getRelevantChunks(query, documentIds, limit = 8) {
      const wanted = documentIds?.length ? new Set(documentIds) : null;
      return supremeCourtChunks
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
      return supremeCourtFiles.filter((file) =>
        wantedDocuments.has(file.documentId) && (!wantedKinds || wantedKinds.has(file.kind)),
      );
    },
    async getDocumentTextFile(documentId) {
      return supremeCourtCases.some((candidate) => candidate.id === documentId)
        ? { documentId, r2Key: supremeCourtCorpusAdapter.artifactKeys.cleanText(documentId) }
        : null;
    },
    async getChunksByIds(chunkIds) {
      const wanted = new Set(chunkIds);
      return supremeCourtChunks.filter((chunk) => wanted.has(chunk.id));
    },
  };
}
