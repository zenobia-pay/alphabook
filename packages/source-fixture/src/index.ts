import type { CorpusAdapter } from "@alphabook/corpus-core";

export const fixtureDocuments = [
  {
    id: "memo-1",
    externalId: "memo-1",
    title: "Incident Memo",
    language: "en",
    rightsStatus: "internal",
    summary: "A short operational memo about a service incident.",
    contributors: ["Operations Team"],
    subjects: ["incidents", "ops"],
    metadata: {
      category: "memo",
      tags: ["incident", "ops"],
    },
  },
  {
    id: "report-1",
    externalId: "report-1",
    title: "Quarterly Reliability Report",
    language: "en",
    rightsStatus: "internal",
    summary: "A short reliability report with service metrics and follow-up actions.",
    contributors: ["Reliability Group"],
    subjects: ["reliability", "reporting"],
    metadata: {
      category: "report",
      tags: ["reliability", "metrics"],
    },
  },
] as const;

export const fixtureCorpusAdapter: CorpusAdapter = {
  id: "fixture",
  displayName: "Fixture Corpus",
  description: "Minimal non-book corpus adapter used to prove the platform is not Gutenberg-only.",
  capabilities: {
    renderedDocuments: true,
    staticContent: {
      routePrefix: "/document-content-static/",
      externalIdPattern: /^[a-z0-9-]+$/u,
    },
  },
  artifactKeys: {
    rawText: (id) => `fixture/raw/${id}/raw.txt`,
    rawMetadata: (id) => `fixture/raw/${id}/metadata.json`,
    cleanText: (id) => `fixture/clean/${id}/clean.txt`,
    chunks: (id) => `fixture/clean/${id}/chunks.jsonl`,
    renderedDocument: (id) => `fixture/clean/${id}/document.html`,
    renderedManifest: (id) => `fixture/clean/${id}/manifest.json`,
    renderedPage: (id, pageNumber) => `fixture/clean/${id}/pages/page-${String(pageNumber).padStart(4, "0")}.html`,
  },
  text: {
    stripSourceBoilerplate: (text) => text.replace(/^SOURCE:\s*/u, "").trim(),
    normalizeText: (text) => text.replace(/\r\n/g, "\n").trim(),
    chunkText: (text, targetSize = 1400) => {
      const normalized = text.trim();
      if (normalized.length <= targetSize) {
        return normalized ? [normalized] : [];
      }
      return normalized.split(/\n{2,}/).filter(Boolean);
    },
  },
  hooks: {
    normalizeQuery(query, filters) {
      return {
        normalizedQuery: query.replace(/\bbooks?\b/giu, "documents").trim(),
        filters,
      };
    },
    summarizeFacets(metadata) {
      const tags = Array.isArray(metadata.tags)
        ? metadata.tags.filter((value): value is string => typeof value === "string")
        : [];
      return tags.map((tag, index) => ({
        label: "tag",
        value: tag,
        score: Math.max(0, 1 - index * 0.1),
      }));
    },
  },
};
