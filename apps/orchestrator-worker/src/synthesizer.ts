import { z } from "zod";

import {
  CitationSchema,
  SYNTHESIZER_SYSTEM_PROMPT,
  type ChunkSearchResult,
  type Citation,
  type ToolName,
} from "@alphabook/shared";
import { HARD_LIMITS } from "@alphabook/corpus-core";
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
  exactCitationLinks?: Array<{
    workId: string;
    chunkId?: string;
    label: string;
    excerpt: string;
    url: string;
  }>;
  billingContext?: BillingContext;
}

export interface SynthesisResult {
  answer: string;
  citations: Citation[];
}

export interface Synthesizer {
  synthesize(input: SynthesisInput): Promise<SynthesisResult>;
}

function truncateForModel(value: string, maxChars = 240) {
  const normalized = value.replace(/\s+/g, " ").trim();
  if (normalized.length <= maxChars) {
    return normalized;
  }
  return `${normalized.slice(0, Math.max(0, maxChars - 1)).trimEnd()}…`;
}

function summarizeForModel(value: unknown, depth = 0): unknown {
  if (value === null || typeof value === "number" || typeof value === "boolean") {
    return value;
  }
  if (typeof value === "string") {
    return truncateForModel(value, 180);
  }
  if (Array.isArray(value)) {
    return value.slice(0, 6).map((entry) => summarizeForModel(entry, depth + 1));
  }
  if (!value || typeof value !== "object" || depth >= 2) {
    return typeof value === "object" ? "[object]" : String(value);
  }
  return Object.fromEntries(
    Object.entries(value)
      .slice(0, 10)
      .map(([key, entry]) => [key, summarizeForModel(entry, depth + 1)]),
  );
}

function summarizeToolHistoryForModel(toolHistory: ToolHistoryEntry[]) {
  return toolHistory.map((entry) => ({
    toolName: entry.toolName,
    rationale: typeof entry.rationale === "string" ? truncateForModel(entry.rationale, 180) : undefined,
    args: summarizeForModel(entry.args),
    result: summarizeForModel(entry.result),
  }));
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

function canonicalizeSearchCharacter(character: string) {
  if (/\s/.test(character)) {
    return " ";
  }
  switch (character) {
    case "’":
    case "‘":
      return "'";
    case "“":
    case "”":
      return "\"";
    case "—":
    case "–":
      return "-";
    default:
      return character.toLowerCase();
  }
}

function normalizeSearchText(raw: string) {
  let normalized = "";
  let previousWasSpace = false;
  for (const character of raw) {
    const next = canonicalizeSearchCharacter(character);
    if (next === " ") {
      if (previousWasSpace) {
        continue;
      }
      previousWasSpace = true;
    } else {
      previousWasSpace = false;
    }
    normalized += next;
  }
  return normalized.trim();
}

function excerptCandidates(excerpt: string) {
  const normalized = normalizeSearchText(excerpt)
    .replace(/^[`"'“”‘’]+|[`"'“”‘’.,;:!?]+$/g, "")
    .trim();
  const segments = normalized
    .split(/[.;!?]\s+|\s+[—–-]\s+/)
    .map((segment) => segment.trim())
    .filter((segment) => segment.length >= 24);
  return [normalized, ...segments]
    .filter((candidate, index, values) => candidate.length >= 12 && values.indexOf(candidate) === index)
    .sort((left, right) => right.length - left.length);
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

function reconcileCitationsWithEvidence(
  citations: Citation[],
  plannerCitations: Citation[],
  toolHistory: ToolHistoryEntry[],
) {
  const chunks = extractChunks(toolHistory);
  const pool = dedupeCitations([
    ...plannerCitations,
    ...chunks.map(chunkCitation),
  ]);

  return dedupeCitations(
    citations.map((citation) => {
      const candidates = excerptCandidates(citation.excerpt);
      const matchedPlannerCitation = pool.find((candidate) =>
        candidates.some((excerpt) => normalizeSearchText(candidate.excerpt).includes(excerpt) || excerpt.includes(normalizeSearchText(candidate.excerpt))),
      );
      if (matchedPlannerCitation) {
        return {
          ...matchedPlannerCitation,
          label: citation.label || matchedPlannerCitation.label,
          excerpt: citation.excerpt || matchedPlannerCitation.excerpt,
        };
      }

      const matchedChunk = chunks.find((chunk) => {
        const chunkText = normalizeSearchText(chunk.text);
        const chunkExcerpt = normalizeSearchText(chunk.excerpt);
        return candidates.some((excerpt) => chunkText.includes(excerpt) || chunkExcerpt.includes(excerpt));
      });
      if (matchedChunk) {
        const canonical = chunkCitation(matchedChunk);
        return {
          ...canonical,
          label: citation.label || canonical.label,
          excerpt: citation.excerpt || canonical.excerpt,
        };
      }

      return citation;
    }),
  );
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
    const runtimeSummary = extractRuntimeSummary(input.toolHistory);
    if (runtimeSummary) {
      const runtimeCitations = extractRuntimeCitations(input.toolHistory);
      const chunkCitations = extractChunks(input.toolHistory).map(chunkCitation);
      return {
        answer: runtimeSummary,
        citations: dedupeCitations([
          ...runtimeCitations,
          ...input.plannerCitations,
          ...chunkCitations,
        ]).slice(0, 16),
      };
    }

    const summarizedToolHistory = summarizeToolHistoryForModel(input.toolHistory);
    const exactCitationLinks = Array.isArray(input.exactCitationLinks)
      ? input.exactCitationLinks.slice(0, 16).map((entry) => ({
          workId: entry.workId,
          ...(entry.chunkId ? { chunkId: entry.chunkId } : {}),
          label: truncateForModel(entry.label, 120),
          excerpt: truncateForModel(entry.excerpt, 220),
          url: entry.url,
        }))
      : [];
    const body = {
      model: this.model,
      response_format: { type: "json_object" as const },
      messages: [
        {
          role: "system",
          content: `${SYNTHESIZER_SYSTEM_PROMPT}
Return a single JSON object with answer and citations.
If exact citation URLs are provided, cite with short markdown links such as [Open passage](ABSOLUTE_URL).
Use the exact provided absolute URL as the href. Do not invent, shorten, rewrite, or substitute any URL.`,
        },
        {
          role: "user",
          content: JSON.stringify({
            question: input.userMessage,
            conversationHistory: input.conversationHistory,
            plannerDraft: input.plannerDraft ?? null,
            toolHistory: summarizedToolHistory,
            exactCitationLinks,
            responseInstructions: "Reply with JSON only.",
            outputShape: {
              answer: "string",
              citations: "array of {workId, chunkId?, label, excerpt, r2Key?}",
            },
          }),
        },
      ],
    };
    let response: Response;
    try {
      response = await this.fetchImpl("https://api.openai.com/v1/chat/completions", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${this.apiKey}`,
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(HARD_LIMITS.MAX_TOOL_TIMEOUT_SECONDS * 1000),
      });
    } catch (error) {
      if (error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError")) {
        throw new Error("Answer synthesis timed out before the final response was ready.");
      }
      throw error;
    }
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
      citations: reconcileCitationsWithEvidence(parsed.citations, input.plannerCitations, input.toolHistory),
    };
  }
}
