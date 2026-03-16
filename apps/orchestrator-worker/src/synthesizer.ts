import { z } from "zod";

import {
  CitationSchema,
  SYNTHESIZER_SYSTEM_PROMPT,
  type ChunkSearchResult,
  type Citation,
  type ToolName,
} from "@alphabook/shared";

const SynthesizerResponseSchema = z.object({
  answer: z.string(),
  citations: z.array(CitationSchema),
});

export interface ToolHistoryEntry {
  toolName: ToolName;
  rationale?: string;
  args: Record<string, unknown>;
  result: Record<string, unknown>;
}

export interface SynthesisInput {
  userMessage: string;
  plannerDraft?: string;
  plannerCitations: Citation[];
  toolHistory: ToolHistoryEntry[];
}

export interface SynthesisResult {
  answer: string;
  citations: Citation[];
}

export interface Synthesizer {
  synthesize(input: SynthesisInput): Promise<SynthesisResult>;
}

function dedupeCitations(citations: Citation[]): Citation[] {
  const seen = new Set<string>();
  const deduped: Citation[] = [];
  for (const citation of citations) {
    const key = `${citation.workId}:${citation.chunkId ?? citation.label}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    deduped.push(citation);
  }
  return deduped;
}

function sanitizeCitations(input: unknown): Citation[] {
  if (!Array.isArray(input)) {
    return [];
  }
  const citations: Citation[] = [];
  for (const candidate of input) {
    if (!candidate || typeof candidate !== "object") {
      continue;
    }
    const record = candidate as Record<string, unknown>;
    const workId = typeof record.workId === "string" ? record.workId : null;
    const label = typeof record.label === "string" ? record.label : null;
    const excerpt = typeof record.excerpt === "string" ? record.excerpt : null;
    if (!workId || !label || !excerpt) {
      continue;
    }
    citations.push({
      workId,
      label,
      excerpt,
      ...(typeof record.chunkId === "string" ? { chunkId: record.chunkId } : {}),
      ...(typeof record.r2Key === "string" ? { r2Key: record.r2Key } : {}),
    });
  }
  return citations;
}

function chunkCitation(chunk: ChunkSearchResult): Citation {
  return {
    workId: chunk.workId,
    chunkId: chunk.id,
    label: `${chunk.workId}#${chunk.chunkIndex}`,
    excerpt: chunk.excerpt,
    r2Key: chunk.r2Key ?? undefined,
  };
}

function extractChunks(toolHistory: ToolHistoryEntry[]): ChunkSearchResult[] {
  return toolHistory.flatMap((entry) => {
    if (!Array.isArray(entry.result.chunks)) {
      return [];
    }
    return entry.result.chunks as ChunkSearchResult[];
  });
}

function extractRuntimeSummary(toolHistory: ToolHistoryEntry[]): string | null {
  for (let index = toolHistory.length - 1; index >= 0; index -= 1) {
    const candidate = toolHistory[index];
    if (candidate.toolName === "run_workspace_task" && typeof candidate.result.briefing === "string") {
      return candidate.result.briefing;
    }
    if (candidate.toolName === "read_workspace_file" && typeof candidate.result.content === "string") {
      return candidate.result.content;
    }
  }
  return null;
}

function extractRuntimeCitations(toolHistory: ToolHistoryEntry[]): Citation[] {
  for (let index = toolHistory.length - 1; index >= 0; index -= 1) {
    const candidate = toolHistory[index];
    if (candidate.toolName === "run_workspace_task") {
      return sanitizeCitations(candidate.result.citations);
    }
  }
  return [];
}

function failedSteps(toolHistory: ToolHistoryEntry[]) {
  return toolHistory
    .filter((entry) => entry.result.ok === false)
    .map((entry) => ({
      toolName: entry.toolName,
      error: typeof entry.result.error === "string" ? entry.result.error : "Unknown error",
    }));
}

function userFacingErrorSummary(toolHistory: ToolHistoryEntry[]): string | null {
  const failures = failedSteps(toolHistory);
  if (failures.length === 0) {
    return null;
  }

  const metadataFailure = failures.find((failure) => failure.toolName === "search_works");
  const workspaceFailure = failures.find((failure) => failure.toolName === "create_workspace");
  const runtimeFailure = failures.find((failure) => failure.toolName === "run_workspace_task");

  if (workspaceFailure || runtimeFailure) {
    return "The full corpus search did not complete for this run, so I do not have a reliable briefing yet.";
  }
  if (metadataFailure) {
    return "The library scan failed early, so this run never built a reliable search plan.";
  }
  return "This run hit an internal search error before the corpus search could finish.";
}

export class FallbackSynthesizer implements Synthesizer {
  async synthesize(input: SynthesisInput): Promise<SynthesisResult> {
    const chunks = extractChunks(input.toolHistory);
    const runtimeSummary = extractRuntimeSummary(input.toolHistory);
    const runtimeCitations = extractRuntimeCitations(input.toolHistory);
    const citations = dedupeCitations([
      ...runtimeCitations,
      ...input.plannerCitations,
      ...chunks.slice(0, 4).map(chunkCitation),
    ]).slice(0, 6);

    if (runtimeSummary) {
      return {
        answer: runtimeSummary,
        citations,
      };
    }

    const failureSummary = userFacingErrorSummary(input.toolHistory);
    if (failureSummary) {
      return {
        answer: failureSummary,
        citations,
      };
    }

    return {
      answer: "The corpus search did not produce a usable briefing for this run, so I am stopping instead of guessing from partial retrieval.",
      citations: [],
    };
  }
}

export class OpenAISynthesizer implements Synthesizer {
  constructor(
    private readonly apiKey: string,
    private readonly model: string,
  ) {}

  async synthesize(input: SynthesisInput): Promise<SynthesisResult> {
    const response = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify({
        model: this.model,
        response_format: { type: "json_object" },
        messages: [
          {
            role: "system",
            content: `${SYNTHESIZER_SYSTEM_PROMPT}\nReturn a single JSON object with answer and citations.`,
          },
          {
            role: "user",
            content: JSON.stringify({
              question: input.userMessage,
              plannerDraft: input.plannerDraft ?? null,
              toolHistory: input.toolHistory,
              responseInstructions: "Reply with JSON only.",
              outputShape: {
                answer: "string",
                citations: "array of {workId, chunkId?, label, excerpt, r2Key?}",
              },
            }),
          },
        ],
      }),
    });
    if (!response.ok) {
      const detail = await response.text();
      throw new Error(`Synthesis request failed: ${detail}`);
    }

    const payload = (await response.json()) as {
      choices?: Array<{
        message?: {
          content?: string;
        };
      }>;
    };
    const content = payload.choices?.[0]?.message?.content;
    if (!content) {
      throw new Error("Synthesis response was empty.");
    }

    const parsedJson = JSON.parse(content) as { answer?: unknown; citations?: unknown };
    const parsed = SynthesizerResponseSchema.parse({
      answer: typeof parsedJson.answer === "string" ? parsedJson.answer : "",
      citations: sanitizeCitations(parsedJson.citations),
    });
    return {
      answer: parsed.answer,
      citations: dedupeCitations(parsed.citations),
    };
  }
}
