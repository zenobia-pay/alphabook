export const HARD_LIMITS = {
  MAX_TURNS: 10,
  MAX_RUNTIME_TASKS_PER_RUN: 4,
  MAX_WORKSPACE_BYTES: 50 * 1024 * 1024,
  MAX_RUNTIME_IDLE_MINUTES: 15,
  MAX_RUN_WALL_CLOCK_SECONDS: 240,
  MAX_TOOL_TIMEOUT_SECONDS: 30,
  MAX_RUNTIME_TOOL_TIMEOUT_SECONDS: 180,
} as const;

export const R2_PREFIXES = {
  rawText: (id: string) => `gutenberg/raw/${id}/raw.txt`,
  rawMetadata: (id: string) => `gutenberg/raw/${id}/metadata.json`,
  coverImage: (id: string, extension = "jpg") => `gutenberg/raw/${id}/cover.${extension.replace(/^\./, "")}`,
  cleanText: (id: string) => `gutenberg/clean/${id}/clean.txt`,
  chunks: (id: string) => `gutenberg/clean/${id}/chunks.jsonl`,
  sessionArtifact: (sessionId: string, filename: string) => `artifacts/sessions/${sessionId}/${filename}`,
  runtimeArtifact: (runtimeId: string, filename: string) => `artifacts/runtimes/${runtimeId}/${filename}`,
} as const;

export const TOOL_LABELS = {
  search_works: "Corpus Search",
  get_work_metadata: "Book Context",
  get_relevant_chunks: "Passage Search",
  get_work_text: "Text Lookup",
  create_workspace: "Research Setup",
  run_workspace_task: "Deep Research",
  read_workspace_file: "Search Notes",
  destroy_workspace: "Cleanup",
} as const;

export function getToolLabel(toolName: string) {
  return TOOL_LABELS[toolName as keyof typeof TOOL_LABELS] ?? "Research step";
}

export const WORKSPACE_POSTGRES_SCHEMA = {
  version: 1,
  summary: "AlphaBook corpus metadata and text index schema used by the orchestrator and VM research agent.",
  tables: [
    {
      name: "works",
      description: "One record per book/work in the corpus.",
      columns: ["id", "gutenberg_id", "title", "language", "release_date", "rights_status", "summary", "metadata_json"],
    },
    {
      name: "authors",
      description: "Canonical author records.",
      columns: ["id", "name", "sort_name"],
    },
    {
      name: "work_authors",
      description: "Many-to-many mapping between works and authors.",
      columns: ["work_id", "author_id"],
    },
    {
      name: "subjects",
      description: "Canonical subject labels.",
      columns: ["id", "label"],
    },
    {
      name: "work_subjects",
      description: "Many-to-many mapping between works and subjects.",
      columns: ["work_id", "subject_id"],
    },
    {
      name: "work_files",
      description: "File inventory for each work, including clean text and chunk JSONL artifacts in R2.",
      columns: ["id", "work_id", "kind", "r2_key", "byte_size", "sha256", "metadata_json"],
    },
    {
      name: "chunks",
      description: "Chunked text passages with vector embeddings, tsvector search index, and optional R2 key.",
      columns: ["id", "work_id", "chunk_index", "text", "embedding", "tsv", "r2_key", "metadata_json"],
    },
    {
      name: "runtime_instances",
      description: "Prepared VM/runtime workspaces and their manifests.",
      columns: ["id", "session_id", "runtime_id", "provider", "provider_machine_id", "status", "manifest_json"],
    },
    {
      name: "artifacts",
      description: "Persisted runtime outputs and other session artifacts stored in R2.",
      columns: ["id", "session_id", "runtime_id", "r2_key", "filename", "mime_type", "metadata_json"],
    },
  ],
} as const;
