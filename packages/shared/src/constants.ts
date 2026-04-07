import { artifactKeys, HARD_LIMITS } from "@alphabook/corpus-core";
import { defaultCorpusAdapter } from "./adapters";

export { HARD_LIMITS };

export const R2_PREFIXES = {
  ...defaultCorpusAdapter.artifactKeys,
  ...artifactKeys,
} as const;

export const TOOL_LABELS = {
  search: "Search",
  design_experiment: "Design Experiment",
  semantic_deep_search: "Semantic Search",
  estimate_research_scope: "Scope Estimate",
  search_works: "Metadata Search",
  get_work_metadata: "Book Context",
  get_relevant_chunks: "Passage Search",
  classify_candidate_chunks: "Relevance Filter",
  get_work_text: "Text Lookup",
  create_workspace: "Research Setup",
  run_workspace_task: "Deep Research",
  read_workspace_file: "Search Notes",
  destroy_workspace: "Cleanup",
} as const;

export function getToolLabel(toolName: string) {
  return TOOL_LABELS[toolName as keyof typeof TOOL_LABELS] ?? "Research step";
}

export const WORKSPACE_SCHEMA = defaultCorpusAdapter.workspaceSchema;
