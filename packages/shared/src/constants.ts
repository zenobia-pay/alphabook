import { artifactKeys, HARD_LIMITS } from "@alphabook/corpus-core";
import { GUTENBERG_WORKSPACE_POSTGRES_SCHEMA } from "@alphabook/source-gutenberg/schema";
import { gutenbergCorpusKeys } from "@alphabook/source-gutenberg/storage";

export { HARD_LIMITS };

export const R2_PREFIXES = {
  ...gutenbergCorpusKeys,
  ...artifactKeys,
} as const;

export const TOOL_LABELS = {
  estimate_research_scope: "Scope Estimate",
  search_works: "Metadata Search",
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

export const WORKSPACE_POSTGRES_SCHEMA = GUTENBERG_WORKSPACE_POSTGRES_SCHEMA;
