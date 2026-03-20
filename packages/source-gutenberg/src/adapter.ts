import type { CorpusAdapter } from "@alphabook/corpus-core";

import { GUTENBERG_WORKSPACE_POSTGRES_SCHEMA } from "./schema";
import { gutenbergCorpusKeys } from "./storage";
import { chunkCorpusText, normalizeCorpusText, stripGutenbergBoilerplate } from "./text";

export const gutenbergCorpusAdapter: CorpusAdapter = {
  id: "gutenberg",
  displayName: "Project Gutenberg",
  description: "Project Gutenberg adapter for AlphaBook's book corpus.",
  workspaceSchema: GUTENBERG_WORKSPACE_POSTGRES_SCHEMA,
  capabilities: {
    renderedDocuments: true,
    coverImages: true,
    staticContent: {
      routePrefix: "/book-content-static/",
      externalIdPattern: /^\d+$/u,
    },
  },
  artifactKeys: {
    ...gutenbergCorpusKeys,
    renderedDocument: gutenbergCorpusKeys.bookHtml,
    renderedManifest: gutenbergCorpusKeys.bookManifest,
    renderedPage: gutenbergCorpusKeys.bookPage,
  },
  text: {
    stripSourceBoilerplate: stripGutenbergBoilerplate,
    normalizeText: normalizeCorpusText,
    chunkText: chunkCorpusText,
  },
  hooks: {
    summarizeFacets(metadata) {
      const bookshelves = Array.isArray(metadata.bookshelves)
        ? metadata.bookshelves.filter((value): value is string => typeof value === "string" && value.trim().length > 0)
        : [];
      return bookshelves.slice(0, 5).map((value, index) => ({
        label: "bookshelf",
        value,
        score: Math.max(0, 1 - index * 0.1),
      }));
    },
  },
};
