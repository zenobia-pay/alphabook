import { z } from "zod";

import {
  CitationSchema,
  SYNTHESIZER_SYSTEM_PROMPT,
  type ChunkSearchResult,
  type Citation,
  type ToolName,
  type WorkSummary,
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

function extractWorks(toolHistory: ToolHistoryEntry[]): WorkSummary[] {
  const works = toolHistory.flatMap((entry) => {
    if (!Array.isArray(entry.result.works)) {
      return [];
    }
    return entry.result.works as WorkSummary[];
  });
  const seen = new Set<string>();
  return works.filter((work) => {
    if (seen.has(work.id)) {
      return false;
    }
    seen.add(work.id);
    return true;
  });
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

function compactMarkdown(markdown: string): string {
  return markdown
    .replace(/^#.*$/gm, "")
    .replace(/^\s*[-*]\s+/gm, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function formatWorkList(works: WorkSummary[]): string {
  if (!works.length) {
    return "the current corpus";
  }
  if (works.length === 1) {
    return works[0].title;
  }
  if (works.length === 2) {
    return `${works[0].title} and ${works[1].title}`;
  }
  return `${works[0].title}, ${works[1].title}, and ${works.length - 2} more works`;
}

export class FallbackSynthesizer implements Synthesizer {
  async synthesize(input: SynthesisInput): Promise<SynthesisResult> {
    const works = extractWorks(input.toolHistory);
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

    const retrievalParagraph = chunks.length
      ? `I started with the indexed corpus and pulled the strongest passages from ${formatWorkList(works)}. The retrieved evidence points in a consistent direction: ${chunks
          .slice(0, 2)
          .map((chunk) => chunk.excerpt.replace(/\s+/g, " ").trim())
          .join(" ")}`
      : `I started with the indexed corpus, but the retrieval pass found only thin evidence for this question.`;

    const runtimeParagraph = `The answer below leans on retrieval evidence only because no deeper runtime briefing was available for this run.`;

    const normalizedDraft = input.plannerDraft
      ? compactMarkdown(input.plannerDraft).replace(/\s+/g, " ").trim()
      : "";
    const draftParagraph = normalizedDraft.length > 0
      ? `Putting those together: ${normalizedDraft}`
      : "Putting those together, the evidence is strong enough to answer directly from the retrieved passages and workspace notes.";

    return {
      answer: [retrievalParagraph, runtimeParagraph, draftParagraph].join("\n\n"),
      citations,
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
