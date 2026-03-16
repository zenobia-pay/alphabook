import { z } from "zod";

import {
  CitationSchema,
  SYNTHESIZER_SYSTEM_PROMPT,
  type ChunkSearchResult,
  type Citation,
  type ToolName,
} from "@alphabook/shared";
import { openAIUsageFromResponse, type BillingContext, type BillingService } from "./billing";
import { parseModelJsonObject } from "./json";

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
  conversationHistory: Array<{
    role: "user" | "assistant" | "system" | "tool";
    content: string;
  }>;
  plannerDraft?: string;
  plannerCitations: Citation[];
  toolHistory: ToolHistoryEntry[];
  billingContext?: BillingContext;
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
  const searchNotesFailure = failures.find((failure) => failure.toolName === "read_workspace_file");

  if (runtimeFailure?.error.includes("evidence artifacts are missing")) {
    return "I could not finish the quoted briefing because the runtime never produced the evidence artifacts that briefing depends on.";
  }
  if (searchNotesFailure?.error.includes("ENOENT") || searchNotesFailure?.error.includes("no such file or directory")) {
    return "I tried to read the search notes back from the runtime, but that file was never written, so I do not have usable evidence notes to show you.";
  }

  if (workspaceFailure || runtimeFailure) {
    return "The full corpus search failed before it could return a usable briefing, so I do not have a reliable final answer for this run.";
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
    private readonly fetchImpl: typeof fetch = (input, init) => fetch(input, init),
    private readonly billing?: BillingService,
  ) {}

  async synthesize(input: SynthesisInput): Promise<SynthesisResult> {
    const body = {
      model: this.model,
      response_format: { type: "json_object" as const },
      messages: [
        {
          role: "system",
          content: `${SYNTHESIZER_SYSTEM_PROMPT}\nReturn a single JSON object with answer and citations.`,
        },
        {
          role: "user",
          content: JSON.stringify({
            question: input.userMessage,
            conversationHistory: input.conversationHistory,
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
    };
    const response = await this.fetchImpl("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify(body),
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
      usage?: Record<string, unknown>;
      id?: string;
    };
    if (this.billing && input.billingContext) {
      const usage = openAIUsageFromResponse(payload as Record<string, unknown>);
      if (usage) {
        await this.billing.track(input.billingContext, {
          provider: "openai",
          model: this.model,
          operation: "chat.completions.create",
          ...usage,
          requestId: payload.id ?? null,
          requestJson: body as unknown as Record<string, unknown>,
          responseJson: {
            usage: payload.usage ?? null,
          },
          metadata: {
            phase: "synthesizer",
            toolHistoryEntries: input.toolHistory.length,
          },
        });
      }
    }
    const content = payload.choices?.[0]?.message?.content;
    if (!content) {
      throw new Error("Synthesis response was empty.");
    }

    const parsedJson = parseModelJsonObject<{ answer?: unknown; citations?: unknown }>(content);
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
