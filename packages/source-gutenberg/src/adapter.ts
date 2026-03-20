import type { CorpusAdapter } from "@alphabook/corpus-core";

import { GUTENBERG_WORKSPACE_POSTGRES_SCHEMA } from "./schema";
import { gutenbergCorpusKeys } from "./storage";
import { chunkCorpusText, normalizeCorpusText, stripGutenbergBoilerplate } from "./text";

export const gutenbergCorpusAdapter: CorpusAdapter = {
  id: "gutenberg",
  displayName: "Project Gutenberg",
  description: "Project Gutenberg adapter for AlphaBook's book corpus.",
  workspaceSchema: GUTENBERG_WORKSPACE_POSTGRES_SCHEMA,
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
};
