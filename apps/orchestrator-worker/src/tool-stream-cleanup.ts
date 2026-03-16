import type { WorkersAiBinding } from "./index";

export const DEFAULT_TOOL_STREAM_CLEANUP_MODEL = "@cf/zai-org/glm-4.7-flash";

export type ToolStreamCleanupLine = {
  toolName: string;
  key: string;
  value: string;
};

export type ToolStreamCleanupResult = {
  summary: string;
  normalizedLines: string[];
};

type WorkersAiTextGenerationResponse = {
  response?: string;
  result?: {
    response?: string;
  };
};

function normalizeModelText(payload: unknown): string {
  if (!payload || typeof payload !== "object") {
    return "";
  }
  const record = payload as WorkersAiTextGenerationResponse;
  const text = typeof record.response === "string"
    ? record.response
    : typeof record.result?.response === "string"
      ? record.result.response
      : "";
  return text.trim();
}

export async function cleanupToolStreamWithWorkersAi(
  ai: WorkersAiBinding,
  input: {
    model?: string;
    toolName: string;
    lines: ToolStreamCleanupLine[];
  },
): Promise<ToolStreamCleanupResult> {
  const prompt = [
    "You normalize tool-call logs for a chat UI.",
    "Return valid JSON with keys summary and normalizedLines.",
    "Keep every retained line terse and factual.",
    "Never invent missing events.",
    "",
    `toolName=${input.toolName}`,
    ...input.lines.map((line) => `${line.key}: ${line.value}`),
  ].join("\n");

  const payload = await ai.run<{ prompt: string }, unknown>(
    input.model ?? DEFAULT_TOOL_STREAM_CLEANUP_MODEL,
    { prompt },
  );
  const text = normalizeModelText(payload);
  if (!text) {
    throw new Error("Workers AI returned an empty cleanup response.");
  }

  const parsed = JSON.parse(text) as Partial<ToolStreamCleanupResult>;
  return {
    summary: typeof parsed.summary === "string" ? parsed.summary : "",
    normalizedLines: Array.isArray(parsed.normalizedLines)
      ? parsed.normalizedLines.filter((line): line is string => typeof line === "string" && line.trim().length > 0)
      : [],
  };
}
