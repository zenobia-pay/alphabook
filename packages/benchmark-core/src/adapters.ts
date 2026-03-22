import { readFile } from "node:fs/promises";
import path from "node:path";

import type { CorpusWorkspaceManifest } from "@alphabook/corpus-core";
import { normalizeWorkspaceChunks, normalizeWorkspaceDocuments } from "@alphabook/corpus-core";

import type { BenchmarkCorpus, BenchmarkLabel, QuerySet } from "./types";

interface JsonlRecord extends Record<string, unknown> {}

interface BeirAdapterOptions {
  corpusId?: string;
  displayName?: string;
  description?: string;
  querySetId?: string;
  querySetVersion?: string;
  querySetDescription?: string;
  defaultFamily?: QuerySet["queries"][number]["family"];
  maxQueries?: number;
  minQrelScore?: number;
}

interface BeirQrelRecord {
  queryId: string;
  corpusId: string;
  score: number;
}

async function readJson<T>(filePath: string): Promise<T> {
  return JSON.parse(await readFile(filePath, "utf8")) as T;
}

async function readJsonl(filePath: string): Promise<JsonlRecord[]> {
  const raw = await readFile(filePath, "utf8");
  return raw
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => JSON.parse(line) as JsonlRecord);
}

function toNullableString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function parseBeirQrels(raw: string): BeirQrelRecord[] {
  return raw
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter(Boolean)
    .filter((line) => !line.startsWith("#"))
    .filter((line) => !/^query[-_\s]?id[\t,\s]/iu.test(line))
    .map((line) => line.split(/\s+/u))
    .filter((parts) => parts.length >= 3)
    .map((parts) => {
      const [queryId, corpusId, scoreRaw] = parts.length >= 4
        ? [parts[0], parts[2], parts[3]]
        : [parts[0], parts[1], parts[2]];
      return {
        queryId: queryId ?? "",
        corpusId: corpusId ?? "",
        score: Number(scoreRaw ?? 0),
      };
    })
    .filter((record) => record.queryId && record.corpusId && Number.isFinite(record.score));
}

function benchmarkIdFromFilePath(filePath: string) {
  return path.basename(path.resolve(filePath)).replace(/\.[^.]+$/u, "");
}

export function benchmarkCorpusFromWorkspaceManifest(
  manifest: CorpusWorkspaceManifest,
  input?: {
    corpusId?: string;
    displayName?: string;
    description?: string;
  },
): BenchmarkCorpus {
  const documents = normalizeWorkspaceDocuments(manifest).map((document) => ({
    id: document.documentId,
    title: document.title ?? document.documentId,
    summary: document.summary ?? null,
    language: document.language ?? null,
    publishedAt: document.publishedAt ?? null,
    rightsStatus: document.rightsStatus ?? null,
    contributors: document.contributors ?? [],
    subjects: document.subjects ?? [],
    metadata: document.metadata ?? {},
  }));

  const passages = normalizeWorkspaceChunks(manifest).map((chunk) => ({
    id: chunk.id,
    documentId: chunk.documentId,
    chunkIndex: chunk.chunkIndex,
    text: chunk.text,
    excerpt: chunk.excerpt,
    metadata: chunk.metadata ?? {},
  }));

  return {
    id: input?.corpusId ?? `workspace-${manifest.runtimeId}`,
    displayName: input?.displayName ?? `Workspace ${manifest.runtimeId}`,
    description: input?.description ?? `Benchmark corpus exported from workspace manifest ${manifest.runtimeId}.`,
    documents,
    passages,
  };
}

export async function loadBenchmarkCorpusFromWorkspaceManifest(
  manifestPath: string,
  input?: {
    corpusId?: string;
    displayName?: string;
    description?: string;
  },
): Promise<BenchmarkCorpus> {
  const manifest = await readJson<CorpusWorkspaceManifest>(manifestPath);
  return benchmarkCorpusFromWorkspaceManifest(manifest, input);
}

export async function loadBeirBenchmarkDataset(
  datasetRoot: string,
  options: BeirAdapterOptions = {},
): Promise<{ corpus: BenchmarkCorpus; querySet: QuerySet }> {
  const root = path.resolve(datasetRoot);
  const datasetId = benchmarkIdFromFilePath(root);
  const corpusRows = await readJsonl(path.join(root, "corpus.jsonl"));
  const queryRows = await readJsonl(path.join(root, "queries.jsonl"));
  const qrelsRaw = await readFile(path.join(root, "qrels.tsv"), "utf8");
  const qrels = parseBeirQrels(qrelsRaw);

  const documents = corpusRows.map((row) => {
    const id = String(row._id ?? row.id ?? "");
    const title = toNullableString(row.title) ?? id;
    const text = toNullableString(row.text) ?? "";
    const metadata = row.metadata && typeof row.metadata === "object" ? row.metadata as Record<string, unknown> : {};
    return {
      id,
      title,
      summary: text.slice(0, 280) || null,
      language: toNullableString(row.language),
      publishedAt: toNullableString(row.publishedAt ?? row.date),
      rightsStatus: toNullableString(row.rightsStatus),
      contributors: Array.isArray(row.contributors) ? row.contributors.map((value) => String(value)) : [],
      subjects: Array.isArray(row.subjects) ? row.subjects.map((value) => String(value)) : [],
      metadata,
    };
  });

  const passages = corpusRows.map((row) => {
    const id = String(row._id ?? row.id ?? "");
    const text = toNullableString(row.text) ?? "";
    const metadata = row.metadata && typeof row.metadata === "object" ? row.metadata as Record<string, unknown> : {};
    return {
      id: `${id}#p0`,
      documentId: id,
      chunkIndex: 0,
      text,
      excerpt: text.slice(0, 280),
      metadata,
    };
  });

  const labelsByQueryId = new Map<string, BenchmarkLabel[]>();
  for (const qrel of qrels) {
    if (qrel.score < (options.minQrelScore ?? 1)) {
      continue;
    }
    const labels = labelsByQueryId.get(qrel.queryId) ?? [];
    labels.push({
      passageId: `${qrel.corpusId}#p0`,
      grade: qrel.score >= 2 ? 2 : 1,
    });
    labelsByQueryId.set(qrel.queryId, labels);
  }

  const selectedQueries = queryRows
    .slice(0, options.maxQueries ?? queryRows.length)
    .map((row) => {
      const queryId = String(row._id ?? row.id ?? "");
      return {
        id: queryId,
        text: String(row.text ?? ""),
        family: options.defaultFamily ?? "lexical-easy",
        labels: labelsByQueryId.get(queryId) ?? [],
        notes: toNullableString(row.metadata && typeof row.metadata === "object" ? (row.metadata as Record<string, unknown>).notes : null) ?? undefined,
      };
    });

  return {
    corpus: {
      id: options.corpusId ?? `${datasetId}-corpus`,
      displayName: options.displayName ?? `BEIR ${datasetId}`,
      description: options.description ?? `Benchmark corpus imported from BEIR-style dataset at ${root}.`,
      documents,
      passages,
    },
    querySet: {
      id: options.querySetId ?? `${datasetId}-queries`,
      version: options.querySetVersion ?? "1.0.0",
      description: options.querySetDescription ?? `Query set imported from BEIR-style dataset at ${root}.`,
      queries: selectedQueries,
    },
  };
}
