import type { ModelTextGenerationBinding } from "./model-binding";

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
  choices?: Array<{
    message?: {
      content?: unknown;
    };
  }>;
};

function normalizeModelText(payload: unknown): string {
  const extract = (value: unknown, depth = 0): string => {
    if (depth > 4 || value == null) {
      return "";
    }
    if (typeof value === "string") {
      return value.trim();
    }
    if (Array.isArray(value)) {
      return value
        .map((entry) => extract(entry, depth + 1))
        .filter((entry) => entry.length > 0)
        .join(" ")
        .trim();
    }
    if (typeof value !== "object") {
      return "";
    }
    const record = value as Record<string, unknown>;
    return extract(
      record.response
      ?? record.output_text
      ?? record.text
      ?? record.result
      ?? record.message
      ?? record.content
      ?? (Array.isArray(record.choices) ? record.choices[0] : null),
      depth + 1,
    );
  };

  return extract(payload);
}

export async function cleanupToolStreamWithWorkersAi(
  ai: ModelTextGenerationBinding,
  input: {
    model?: string;
    toolName: string;
    lines: ToolStreamCleanupLine[];
  },
): Promise<ToolStreamCleanupResult> {
  const prompt = [
    "You normalize tool-call logs for a chat UI.",
    "Return valid JSON with keys summary and normalizedLines.",
    "Keep every retained line terse, factual, and easy for a non-technical reader to understand.",
    "Remove formatting noise, stack traces, internal jargon, IDs, file paths, secrets, tokens, cookies, and sensitive data.",
    "If several lines are repetitive, vague, or too small to stand alone, merge them into one clearer line.",
    "Prefer plain English over implementation detail.",
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
