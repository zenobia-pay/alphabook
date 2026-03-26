export const GUTENBERG_WORKSPACE_SCHEMA = {
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
      description: "Chunked text passages with optional R2 key and embedding metadata.",
      columns: ["id", "work_id", "chunk_index", "text", "r2_key", "metadata_json"],
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
