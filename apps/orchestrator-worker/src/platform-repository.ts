import type {
  CorpusChunkRecord,
  CorpusRepository,
} from "@alphabook/platform";

import type {
  AppStore,
  DocumentFileKind,
  PassageSearchFilters,
} from "./store";

export function createPlatformRepository(store: AppStore): CorpusRepository {
  return {
    async countDocuments() {
      return store.countDocuments();
    },
    async listDocuments(offset, limit) {
      return store.listDocuments(offset, limit);
    },
    async getDocumentById(documentId) {
      return store.getDocumentById(documentId);
    },
    async searchDocuments(query, filters) {
      return store.searchDocuments(query, filters);
    },
    async getDocumentMetadata(documentIds) {
      return store.getDocumentMetadata(documentIds);
    },
    async getRelevantChunks(query, documentIds, limit, embedding, filters) {
      return store.getRelevantDocumentChunks(
        query,
        documentIds,
        limit,
        embedding,
        filters as PassageSearchFilters | undefined,
      );
    },
    async getDocumentFiles(documentIds, kinds) {
      const normalizedKinds = kinds?.filter((kind): kind is DocumentFileKind =>
        kind === "raw" || kind === "metadata" || kind === "clean" || kind === "chunks" || kind === "book_html",
      );
      return store.getDocumentFiles(documentIds, normalizedKinds);
    },
    async getDocumentTextFile(documentId) {
      return store.getDocumentTextFile(documentId);
    },
    async getChunksByIds(chunkIds) {
      const chunks = await store.getChunksByIds(chunkIds);
      return chunks.map((chunk) => ({
        id: chunk.id,
        documentId: chunk.workId,
        chunkIndex: chunk.chunkIndex,
        text: chunk.text,
        excerpt: chunk.excerpt,
        r2Key: chunk.r2Key,
        score: chunk.score,
      }));
    },
  };
}
