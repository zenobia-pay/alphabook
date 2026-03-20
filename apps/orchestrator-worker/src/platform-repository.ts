import type {
  CorpusChunkRecord,
  CorpusDocumentRecord,
  CorpusFileRecord,
  CorpusRepository,
} from "@alphabook/platform";
import {
  workDetailToDocumentDetail,
  workSummaryToDocumentSummary,
} from "@alphabook/platform";

import type {
  AppStore,
  PassageSearchFilters,
  WorkFileKind,
  WorkFileRecord,
} from "./store";

function mapWorkFileToCorpusFile(file: WorkFileRecord): CorpusFileRecord {
  return {
    documentId: file.workId,
    kind: file.kind,
    r2Key: file.r2Key,
    byteSize: file.byteSize,
    metadata: file.metadata,
  };
}

export function createPlatformRepository(store: AppStore): CorpusRepository {
  return {
    async countDocuments() {
      return store.countWorks();
    },
    async listDocuments(offset, limit) {
      const works = await store.listWorks(offset, limit);
      return works.map((work) => workSummaryToDocumentSummary(work) as CorpusDocumentRecord);
    },
    async getDocumentById(documentId) {
      const work = await store.getWorkById(documentId);
      return work ? workDetailToDocumentDetail(work) as CorpusDocumentRecord : null;
    },
    async searchDocuments(query, filters) {
      const works = await store.searchWorks(query, filters);
      return works.map((work) => workSummaryToDocumentSummary(work) as CorpusDocumentRecord);
    },
    async getDocumentMetadata(documentIds) {
      const works = await store.getWorkMetadata(documentIds);
      return works.map((work) => workSummaryToDocumentSummary(work) as CorpusDocumentRecord);
    },
    async getRelevantChunks(query, documentIds, limit, embedding, filters) {
      const chunks = await store.getRelevantChunks(
        query,
        documentIds,
        limit,
        embedding,
        filters as PassageSearchFilters | undefined,
      );
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
    async getDocumentFiles(documentIds, kinds) {
      const normalizedKinds = kinds?.filter((kind): kind is WorkFileKind =>
        kind === "raw" || kind === "metadata" || kind === "clean" || kind === "chunks" || kind === "book_html",
      );
      const files = await store.getWorkFiles(documentIds, normalizedKinds);
      return files.map(mapWorkFileToCorpusFile);
    },
    async getDocumentTextFile(documentId) {
      const record = await store.getWorkTextFile(documentId);
      return record ? { documentId: record.workId, r2Key: record.r2Key } : null;
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
