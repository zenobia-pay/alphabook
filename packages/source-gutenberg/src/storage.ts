export const gutenbergCorpusKeys = {
  rawText: (id: string) => `gutenberg/raw/${id}/raw.txt`,
  rawMetadata: (id: string) => `gutenberg/raw/${id}/metadata.json`,
  coverImage: (id: string, extension = "jpg") => `gutenberg/raw/${id}/cover.${extension.replace(/^\./, "")}`,
  cleanText: (id: string) => `gutenberg/clean/${id}/clean.txt`,
  chunks: (id: string) => `gutenberg/clean/${id}/chunks.jsonl`,
  bookHtml: (id: string) => `gutenberg/clean/${id}/book.html`,
  bookManifest: (id: string) => `gutenberg/clean/${id}/book/manifest.json`,
  bookPage: (id: string, pageNumber: number) => `gutenberg/clean/${id}/book/pages/page-${String(pageNumber).padStart(4, "0")}.html`,
} as const;
