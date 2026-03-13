import {
  HARD_LIMITS,
  PLANNER_SYSTEM_PROMPT,
  PlannerDecisionSchema,
  type Citation,
  type PlannerDecision,
  type PlannerToolCall,
  type ToolName,
} from "@alphabook/shared";

import type { ChunkSearchResult, WorkSummary } from "@alphabook/shared";

export interface PlannerContext {
  userMessage: string;
  turns: number;
  toolHistory: Array<{
    toolName: ToolName;
    args: Record<string, unknown>;
    result: Record<string, unknown>;
  }>;
  workScope?: string[];
}

export interface Planner {
  decide(context: PlannerContext): Promise<PlannerDecision>;
}

function extractCitationsFromChunks(chunks: ChunkSearchResult[]): Citation[] {
  return chunks.slice(0, 4).map((chunk) => ({
    workId: chunk.workId,
    chunkId: chunk.id,
    label: `${chunk.workId}#${chunk.chunkIndex}`,
    excerpt: chunk.excerpt,
    r2Key: chunk.r2Key ?? undefined,
  }));
}

function isComparisonQuery(query: string): boolean {
  return /\b(compare|contrast|versus|vs\.?|between|across)\b/i.test(query);
}

function needsWorkspaceSearch(query: string, workIds: string[], chunkCount: number): boolean {
  if (isComparisonQuery(query)) {
    return true;
  }
  if (workIds.length > 1) {
    return true;
  }
  if (chunkCount >= 4) {
    return true;
  }
  return /\b(all|every|trace|theme|pattern|survey|synthesize|search|find|why|how|where|when|corpus)\b/i.test(query);
}

function metadataWorkIds(context: PlannerContext, limit = 12): string[] {
  const searchResult = context.toolHistory.find((item) => item.toolName === "search_works")?.result;
  const works = Array.isArray(searchResult?.works) ? searchResult.works as WorkSummary[] : [];
  return works.slice(0, limit).map((work) => work.id);
}

function seedChunkPayload(context: PlannerContext): ChunkSearchResult[] {
  const chunkResult = context.toolHistory.find((item) => item.toolName === "get_relevant_chunks")?.result;
  return (chunkResult?.chunks as ChunkSearchResult[] | undefined) ?? [];
}

function phaseResult(context: PlannerContext, phase: string): Record<string, unknown> | null {
  for (let index = context.toolHistory.length - 1; index >= 0; index -= 1) {
    const entry = context.toolHistory[index];
    if (entry.toolName !== "run_workspace_task") {
      continue;
    }
    const taskSpec = entry.args.taskSpec as Record<string, unknown> | undefined;
    if (typeof taskSpec?.phase === "string" && taskSpec.phase === phase) {
      return entry.result;
    }
  }
  return null;
}

function hasReadWorkspacePath(context: PlannerContext, path: string): boolean {
  return context.toolHistory.some((entry) =>
    entry.toolName === "read_workspace_file" && entry.args.path === path,
  );
}

function artifactPath(result: Record<string, unknown> | null, patterns: RegExp[]): string | null {
  if (!Array.isArray(result?.artifacts)) {
    return null;
  }
  for (const artifact of result.artifacts as Array<Record<string, unknown>>) {
    if (typeof artifact.path !== "string") {
      continue;
    }
    if (patterns.some((pattern) => pattern.test(artifact.path))) {
      return artifact.path;
    }
  }
  return null;
}

export class FallbackPlanner implements Planner {
  async decide(context: PlannerContext): Promise<PlannerDecision> {
    const toolNames = context.toolHistory.map((item) => item.toolName);
    const scopedWorkIds = context.workScope?.length ? context.workScope : [];
    if (!toolNames.includes("search_works")) {
      return {
        type: "tool_call",
        tool_name: "search_works",
        rationale: "I’m going to scan corpus metadata first, then pull seed matches, then run a two-stage VM search over the candidate texts.",
        args: {
          query: context.userMessage,
          filters: {
            limit: 12,
          },
        },
      };
    }

    const metadataIds = scopedWorkIds.length > 0 ? scopedWorkIds.slice(0, 12) : metadataWorkIds(context, 12);
    if (!toolNames.includes("get_work_metadata") && metadataIds.length > 0) {
      return {
        type: "tool_call",
        tool_name: "get_work_metadata",
        rationale: "I have candidate books from the metadata scan. Next I’m loading their metadata so the VM gets a richer corpus map before searching.",
        args: {
          workIds: metadataIds,
        },
      };
    }

    if (!toolNames.includes("get_relevant_chunks")) {
      return {
        type: "tool_call",
        tool_name: "get_relevant_chunks",
        rationale: scopedWorkIds.length > 0
          ? "I’ve loaded metadata. Now I’m doing an initial index scan inside the open book to seed the VM search."
          : "I’ve loaded metadata. Now I’m doing an initial index scan across the corpus to seed the VM search.",
        args: {
          query: context.userMessage,
          ...(metadataIds.length > 0 ? { workIds: metadataIds } : {}),
          filters: {
            limit: 20,
          },
        },
      };
    }

    const chunks = seedChunkPayload(context);
    const workIds = Array.from(new Set([
      ...metadataIds,
      ...chunks.map((chunk) => chunk.workId),
    ])).slice(0, 12);

    if (!toolNames.includes("create_workspace")) {
      return {
        type: "tool_call",
        tool_name: "create_workspace",
        rationale: "The initial scans are complete. I’m preparing a bounded VM workspace so the long-running agent can search the candidate corpus directly.",
        args: {
          workIds,
          chunkIds: chunks.slice(0, 24).map((chunk) => chunk.id),
          taskContext: {
            question: context.userMessage,
            mode: "exhaustive_corpus_search",
            candidateWorkIds: workIds,
            topChunks: chunks.slice(0, 12).map((chunk) => ({
              chunkId: chunk.id,
              workId: chunk.workId,
              excerpt: chunk.excerpt,
            })),
          },
        },
      };
    }

    const runtimeId = context.toolHistory.find((item) => item.toolName === "create_workspace")?.result.runtimeId;
    if (typeof runtimeId !== "string") {
      return {
        type: "final_answer",
        answer: "I prepared the search plan, but I could not start the workspace runtime.",
        citations: extractCitationsFromChunks(chunks),
      };
    }

    const collectResult = phaseResult(context, "collect_evidence");
    if (!collectResult) {
      return {
        type: "tool_call",
        tool_name: "run_workspace_task",
        rationale: "The workspace is ready. I’m starting VM pass 1 to collect evidence and assemble the search corpus.",
        args: {
          runtimeId,
          taskSpec: {
            kind: "briefing_search",
            phase: "collect_evidence",
            question: context.userMessage,
            workIds,
            chunkIds: chunks.slice(0, 24).map((chunk) => chunk.id),
            evidenceFile: "output/evidence.json",
            evidenceNotesFile: "output/evidence-notes.md",
          },
        },
      };
    }

    const evidencePath = artifactPath(collectResult, [/output\/evidence-notes\.md$/u, /output\/summary\.md$/u]) ?? "output/evidence-notes.md";
    if (!hasReadWorkspacePath(context, evidencePath)) {
      return {
        type: "tool_call",
        tool_name: "read_workspace_file",
        rationale: "VM pass 1 finished. I’m reading the evidence notes back so the search progress is visible in the thread.",
        args: {
          runtimeId,
          path: evidencePath,
        },
      };
    }

    const briefingResult = phaseResult(context, "write_briefing");
    if (!briefingResult) {
      return {
        type: "tool_call",
        tool_name: "run_workspace_task",
        rationale: "The evidence set is ready. I’m starting VM pass 2 to write the final quoted briefing.",
        args: {
          runtimeId,
          taskSpec: {
            kind: "briefing_search",
            phase: "write_briefing",
            question: context.userMessage,
            workIds,
            chunkIds: chunks.slice(0, 24).map((chunk) => chunk.id),
            briefingFile: "output/briefing.md",
            briefingJsonFile: "output/briefing.json",
          },
        },
      };
    }

    if (typeof briefingResult.briefing === "string" && briefingResult.briefing.trim().length > 0) {
      return {
        type: "final_answer",
        answer: briefingResult.briefing,
        citations: extractCitationsFromChunks(chunks),
      };
    }

    const finalBriefingPath = artifactPath(briefingResult, [/output\/briefing\.md$/u, /output\/summary\.md$/u]) ?? "output/briefing.md";
    if (!hasReadWorkspacePath(context, finalBriefingPath)) {
      return {
        type: "tool_call",
        tool_name: "read_workspace_file",
        rationale: "VM pass 2 finished. I’m reading the generated briefing back into the chat.",
        args: {
          runtimeId,
          path: finalBriefingPath,
        },
      };
    }

    const summary = context.toolHistory.find((item) => item.toolName === "read_workspace_file" && item.args.path === finalBriefingPath)?.result.content;
    return {
      type: "final_answer",
      answer: typeof summary === "string" && summary.trim().length
        ? summary.slice(0, 1600)
        : "I completed the VM evidence collection and briefing pass, but the final briefing artifact was empty.",
      citations: extractCitationsFromChunks(chunks),
    };
  }
}

export class ScriptedPlanner implements Planner {
  private cursor = 0;

  constructor(private readonly script: PlannerDecision[]) {}

  async decide(): Promise<PlannerDecision> {
    const next = this.script[this.cursor];
    this.cursor += 1;
    if (!next) {
      throw new Error("Scripted planner exhausted.");
    }
    return next;
  }
}

export class OpenAIPlanner implements Planner {
  private readonly fallbackPlanner = new FallbackPlanner();

  constructor(
    private readonly apiKey: string,
    private readonly model: string,
  ) {}

  async decide(context: PlannerContext): Promise<PlannerDecision> {
    try {
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
              content: `${PLANNER_SYSTEM_PROMPT}\nReturn a single JSON object that matches the requested output shape.`,
            },
            {
              role: "user",
              content: JSON.stringify({
                task: "Choose the next AlphaBook action.",
                responseInstructions: "Reply with JSON only.",
                hardLimits: HARD_LIMITS,
                availableTools: [
                  "search_works(query, filters?)",
                  "get_work_metadata(work_ids)",
                  "get_relevant_chunks(query, work_ids?, filters?)",
                  "get_work_text(work_id)",
                  "create_workspace(work_ids, chunk_ids, task_context)",
                  "run_workspace_task(runtime_id, task_spec)",
                  "read_workspace_file(runtime_id, path)",
                  "destroy_workspace(runtime_id)",
                ],
                context,
                plannerNotes: context.workScope?.length
                  ? "A workScope is present. Stay inside those work IDs unless the user explicitly asks to widen scope."
                  : null,
                outputShape: {
                  type: "tool_call | final_answer",
                  tool_name: "one of the available tools when using tool_call",
                  args: "object",
                  rationale: "optional short plain-English sentence about the next step when using tool_call",
                  answer: "string",
                  citations: "array of {workId, chunkId?, label, excerpt, r2Key?}",
                },
              }),
            },
          ],
        }),
      });
      if (!response.ok) {
        const text = await response.text();
        throw new Error(`Planner request failed: ${text}`);
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
        throw new Error("Planner response was empty.");
      }
      return PlannerDecisionSchema.parse(JSON.parse(content));
    } catch {
      return this.fallbackPlanner.decide(context);
    }
  }
}

export function parseToolCall(decision: PlannerDecision): PlannerToolCall | null {
  return decision.type === "tool_call" ? decision : null;
}
