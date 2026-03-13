export const HARD_LIMITS = {
  MAX_TURNS: 10,
  MAX_RUNTIME_TASKS_PER_RUN: 4,
  MAX_WORKSPACE_BYTES: 50 * 1024 * 1024,
  MAX_RUNTIME_IDLE_MINUTES: 15,
  MAX_RUN_WALL_CLOCK_SECONDS: 90,
  MAX_TOOL_TIMEOUT_SECONDS: 30,
  MAX_RUNTIME_TOOL_TIMEOUT_SECONDS: 60,
} as const;

export const R2_PREFIXES = {
  rawText: (id: string) => `gutenberg/raw/${id}/raw.txt`,
  rawMetadata: (id: string) => `gutenberg/raw/${id}/metadata.json`,
  cleanText: (id: string) => `gutenberg/clean/${id}/clean.txt`,
  chunks: (id: string) => `gutenberg/clean/${id}/chunks.jsonl`,
  sessionArtifact: (sessionId: string, filename: string) => `artifacts/sessions/${sessionId}/${filename}`,
  runtimeArtifact: (runtimeId: string, filename: string) => `artifacts/runtimes/${runtimeId}/${filename}`,
} as const;

export const TOOL_LABELS = {
  search_works: "Scanning the corpus",
  get_work_metadata: "Reading work metadata",
  get_relevant_chunks: "Pulling grounded passages",
  get_work_text: "Opening full text",
  create_workspace: "Preparing a VM workspace",
  run_workspace_task: "Running the long VM search",
  read_workspace_file: "Collecting VM notes",
  destroy_workspace: "Closing the VM workspace",
} as const;

export function getToolLabel(toolName: string) {
  return TOOL_LABELS[toolName as keyof typeof TOOL_LABELS] ?? "Updating the run";
}
