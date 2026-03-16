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
import { openAIUsageFromResponse, type BillingContext, type BillingService } from "./billing";

export interface PlannerContext {
  userMessage: string;
  conversationHistory: Array<{
    role: "user" | "assistant" | "system" | "tool";
    content: string;
  }>;
  turns: number;
  toolHistory: Array<{
    toolName: ToolName;
    args: Record<string, unknown>;
    result: Record<string, unknown>;
  }>;
  workScope?: string[];
  billingContext?: BillingContext;
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

function phaseRuntimeId(context: PlannerContext, phase: string): string | null {
  const result = phaseResult(context, phase);
  return typeof result?.runtimeId === "string" ? result.runtimeId : null;
}

function latestRuntimeResult(context: PlannerContext): Record<string, unknown> | null {
  for (let index = context.toolHistory.length - 1; index >= 0; index -= 1) {
    const entry = context.toolHistory[index];
    if (entry.toolName === "run_workspace_task") {
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
    const path = typeof artifact.path === "string" ? artifact.path : null;
    if (!path) {
      continue;
    }
    if (patterns.some((pattern) => pattern.test(path))) {
      return path;
    }
  }
  return null;
}

function toolCallCount(context: PlannerContext, toolName: ToolName): number {
  return context.toolHistory.filter((entry) => entry.toolName === toolName).length;
}

function lastToolCall(context: PlannerContext): PlannerContext["toolHistory"][number] | null {
  return context.toolHistory.length > 0 ? context.toolHistory[context.toolHistory.length - 1] : null;
}

function repeatedRetrievalLoop(context: PlannerContext): boolean {
  const retrievalTurns = context.toolHistory.filter((entry) =>
    entry.toolName === "search_works" || entry.toolName === "get_relevant_chunks"
  );
  if (retrievalTurns.length < 3) {
    return false;
  }
  const recent = retrievalTurns.slice(-3);
  return recent.every((entry) =>
    entry.toolName === "search_works" || entry.toolName === "get_relevant_chunks"
  );
}

function deterministicRescueDecision(context: PlannerContext): PlannerDecision | null {
  const chunks = seedChunkPayload(context);
  const scopedWorkIds = context.workScope?.length ? context.workScope : [];
  const metadataIds = scopedWorkIds.length > 0 ? scopedWorkIds.slice(0, 12) : metadataWorkIds(context, 12);
  const workIds = Array.from(new Set([
    ...metadataIds,
    ...chunks.map((chunk) => chunk.workId),
  ])).slice(0, 12);
  const runtimeId = context.toolHistory.find((item) => item.toolName === "create_workspace")?.result.runtimeId;
  const latestRuntime = latestRuntimeResult(context);

  if (!repeatedRetrievalLoop(context)) {
    return null;
  }

  if (toolCallCount(context, "create_workspace") === 0) {
    return {
      type: "tool_call",
      tool_name: "create_workspace",
      rationale: "The quick retrieval loop is thin, so I’m escalating to the deeper corpus search now.",
      args: {
        workIds,
        chunkIds: chunks.slice(0, 24).map((chunk) => chunk.id),
        taskContext: {
          question: context.userMessage,
          mode: scopedWorkIds.length > 0 ? "open_book_analysis" : "exhaustive_corpus_search",
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

  if (typeof runtimeId === "string" && toolCallCount(context, "run_workspace_task") === 0) {
    return {
      type: "tool_call",
      tool_name: "run_workspace_task",
      rationale: "The quick retrieval loop is not converging, so I’m running the full Codex corpus search now.",
      args: {
        runtimeId,
        taskSpec: {
          kind: "briefing_search",
          phase: "collect_and_brief",
          question: context.userMessage,
          workIds,
          chunkIds: chunks.slice(0, 24).map((chunk) => chunk.id),
          evidenceFile: "output/evidence.json",
          evidenceNotesFile: "output/evidence-notes.md",
          briefingFile: "output/briefing.md",
          briefingJsonFile: "output/briefing.json",
        },
      },
    };
  }

  if (latestRuntime && typeof runtimeId === "string") {
    const finalBriefingPath = artifactPath(latestRuntime, [/output\/briefing\.md$/u, /output\/summary\.md$/u]) ?? "output/briefing.md";
    if (!hasReadWorkspacePath(context, finalBriefingPath)) {
      return {
        type: "tool_call",
        tool_name: "read_workspace_file",
        rationale: "The Codex search finished, and I’m pulling the briefing back into the chat now.",
        args: {
          runtimeId,
          path: finalBriefingPath,
        },
      };
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
        rationale: "Scanning the library for likely books and themes.",
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
        rationale: "Loading context for the books most likely to matter.",
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
          ? "Pulling a few seed passages from the open book."
          : "Pulling a few seed passages from across the corpus.",
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
        rationale: "Preparing the workspace for the full corpus search.",
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

    const briefingResult = latestRuntimeResult(context);
    if (!briefingResult) {
      return {
        type: "tool_call",
        tool_name: "run_workspace_task",
        rationale: "Running the full corpus search and writing the briefing.",
        args: {
          runtimeId,
          taskSpec: {
            kind: "briefing_search",
            phase: "collect_and_brief",
            question: context.userMessage,
            workIds,
            chunkIds: chunks.slice(0, 24).map((chunk) => chunk.id),
            evidenceFile: "output/evidence.json",
            evidenceNotesFile: "output/evidence-notes.md",
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
        citations: Array.isArray(briefingResult.citations) ? briefingResult.citations as Citation[] : extractCitationsFromChunks(chunks),
      };
    }

    const finalBriefingPath = artifactPath(briefingResult, [/output\/briefing\.md$/u, /output\/summary\.md$/u]) ?? "output/briefing.md";
    if (!hasReadWorkspacePath(context, finalBriefingPath)) {
      return {
        type: "tool_call",
        tool_name: "read_workspace_file",
        rationale: "Bringing the finished briefing back into the chat.",
        args: {
          runtimeId: typeof briefingResult.runtimeId === "string" ? briefingResult.runtimeId : runtimeId,
          path: finalBriefingPath,
        },
      };
    }

    const summary = context.toolHistory.find((item) => item.toolName === "read_workspace_file" && item.args.path === finalBriefingPath)?.result.content;
    return {
      type: "final_answer",
      answer: typeof summary === "string" && summary.trim().length
        ? summary.slice(0, 1600)
        : "The corpus search finished without a readable briefing file, so I cannot show a reliable final answer from this run.",
      citations: Array.isArray(briefingResult.citations) ? briefingResult.citations as Citation[] : extractCitationsFromChunks(chunks),
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
  constructor(
    private readonly apiKey: string,
    private readonly model: string,
    private readonly fetchImpl: typeof fetch = (input, init) => fetch(input, init),
    private readonly billing?: BillingService,
  ) {}

  async decide(context: PlannerContext): Promise<PlannerDecision> {
    const body = {
      model: this.model,
      response_format: { type: "json_object" as const },
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
      const text = await response.text();
      throw new Error(`Planner request failed: ${text}`);
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
    if (this.billing && context.billingContext) {
      const usage = openAIUsageFromResponse(payload as Record<string, unknown>);
      if (usage) {
        await this.billing.track(context.billingContext, {
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
            phase: "planner",
            turn: context.turns,
          },
        });
      }
    }
    const content = payload.choices?.[0]?.message?.content;
    if (!content) {
      throw new Error("Planner response was empty.");
    }
    const parsed = PlannerDecisionSchema.parse(JSON.parse(content));
    const rescue = deterministicRescueDecision(context);
    if (rescue) {
      const parsedTool = parsed.type === "tool_call" ? parsed.tool_name : null;
      const rescueTool = rescue.type === "tool_call" ? rescue.tool_name : null;
      if (
        parsed.type !== "final_answer"
        && (
          parsedTool === "search_works"
          || parsedTool === "get_relevant_chunks"
          || parsedTool !== rescueTool
        )
      ) {
        return rescue;
      }
    }
    return parsed;
  }
}

export function parseToolCall(decision: PlannerDecision): PlannerToolCall | null {
  return decision.type === "tool_call" ? decision : null;
}
