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
import { parseModelJsonObject } from "./json";

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
  pendingTools?: Array<{
    toolName: ToolName;
    args: Record<string, unknown>;
  }>;
  workScope?: string[];
  billingContext?: BillingContext;
}

export interface Planner {
  decide(context: PlannerContext): Promise<PlannerDecision>;
}

const VALID_TOOL_NAMES = new Set<ToolName>([
  "search_works",
  "get_work_metadata",
  "get_relevant_chunks",
  "get_work_text",
  "create_workspace",
  "run_workspace_task",
  "read_workspace_file",
  "destroy_workspace",
]);

function truncateForModel(value: string, maxChars = 240) {
  const normalized = value.replace(/\s+/g, " ").trim();
  if (normalized.length <= maxChars) {
    return normalized;
  }
  return `${normalized.slice(0, Math.max(0, maxChars - 1)).trimEnd()}…`;
}

function summarizePlannerValue(value: unknown, depth = 0): unknown {
  if (value === null || typeof value === "number" || typeof value === "boolean") {
    return value;
  }
  if (typeof value === "string") {
    return truncateForModel(value, 180);
  }
  if (Array.isArray(value)) {
    return value.slice(0, 6).map((entry) => summarizePlannerValue(entry, depth + 1));
  }
  if (!value || typeof value !== "object" || depth >= 2) {
    return typeof value === "object" ? "[object]" : String(value);
  }
  return Object.fromEntries(
    Object.entries(value)
      .slice(0, 10)
      .map(([key, entry]) => [key, summarizePlannerValue(entry, depth + 1)]),
  );
}

function summarizePlannerToolResult(toolName: ToolName, result: Record<string, unknown>) {
  switch (toolName) {
    case "search_works": {
      const works = Array.isArray(result.works) ? result.works as Array<Record<string, unknown>> : [];
      return {
        workCount: works.length,
        works: works.slice(0, 5).map((work) => ({
          id: typeof work.id === "string" ? work.id : null,
          title: typeof work.title === "string" ? truncateForModel(work.title, 120) : null,
          authors: Array.isArray(work.authors) ? (work.authors as unknown[]).filter((author): author is string => typeof author === "string").slice(0, 3) : [],
        })),
      };
    }
    case "get_work_metadata": {
      const works = Array.isArray(result.works) ? result.works as Array<Record<string, unknown>> : [];
      return {
        workCount: works.length,
        works: works.slice(0, 5).map((work) => ({
          id: typeof work.id === "string" ? work.id : null,
          title: typeof work.title === "string" ? truncateForModel(work.title, 120) : null,
          summary: typeof work.summary === "string" ? truncateForModel(work.summary, 140) : null,
        })),
      };
    }
    case "get_relevant_chunks": {
      const chunks = Array.isArray(result.chunks) ? result.chunks as Array<Record<string, unknown>> : [];
      return {
        chunkCount: chunks.length,
        chunks: chunks.slice(0, 6).map((chunk) => ({
          id: typeof chunk.id === "string" ? chunk.id : null,
          workId: typeof chunk.workId === "string" ? chunk.workId : null,
          chunkIndex: typeof chunk.chunkIndex === "number" ? chunk.chunkIndex : null,
          excerpt: typeof chunk.excerpt === "string" ? truncateForModel(chunk.excerpt, 180) : null,
        })),
      };
    }
    case "create_workspace": {
      const manifest = result.manifest && typeof result.manifest === "object"
        ? result.manifest as Record<string, unknown>
        : null;
      const works = Array.isArray(manifest?.works) ? manifest.works as Array<Record<string, unknown>> : [];
      return {
        ok: result.ok === true,
        reused: result.reused === true,
        runtimeId: typeof result.runtimeId === "string" ? result.runtimeId : null,
        workCount: works.length,
        works: works.slice(0, 5).map((work) => ({
          workId: typeof work.workId === "string" ? work.workId : null,
          title: typeof work.title === "string" ? truncateForModel(work.title, 120) : null,
        })),
        error: typeof result.error === "string" ? truncateForModel(result.error, 180) : null,
      };
    }
    case "run_workspace_task": {
      const citations = Array.isArray(result.citations) ? result.citations : [];
      const artifacts = Array.isArray(result.artifacts) ? result.artifacts : [];
      return {
        ok: result.ok === true || typeof result.briefing === "string",
        runtimeId: typeof result.runtimeId === "string" ? result.runtimeId : null,
        citationCount: citations.length,
        artifactCount: artifacts.length,
        briefingPreview: typeof result.briefing === "string" ? truncateForModel(result.briefing, 280) : null,
        error: typeof result.error === "string" ? truncateForModel(result.error, 180) : null,
      };
    }
    case "read_workspace_file":
      return {
        path: typeof result.path === "string" ? result.path : null,
        size: typeof result.size === "number" ? result.size : null,
        contentPreview: typeof result.content === "string" ? truncateForModel(result.content, 280) : null,
        error: typeof result.error === "string" ? truncateForModel(result.error, 180) : null,
      };
    default:
      return Object.fromEntries(
        Object.entries(result)
          .slice(0, 8)
          .map(([key, value]) => [key, typeof value === "string" ? truncateForModel(value, 180) : value]),
      );
  }
}

function summarizePlannerContext(context: PlannerContext) {
  return {
    userMessage: truncateForModel(context.userMessage, 500),
    turns: context.turns,
    workScope: context.workScope?.slice(0, 12) ?? [],
    conversationHistory: context.conversationHistory.map((entry) => ({
      role: entry.role,
      content: truncateForModel(entry.content, 320),
    })),
    toolHistory: context.toolHistory.map((entry) => ({
      toolName: entry.toolName,
      args: Object.fromEntries(
        Object.entries(entry.args).slice(0, 12).map(([key, value]) => [key, summarizePlannerValue(value)]),
      ),
      result: summarizePlannerToolResult(entry.toolName, entry.result),
    })),
    pendingTools: (context.pendingTools ?? []).map((entry) => ({
      toolName: entry.toolName,
      args: summarizePlannerValue(entry.args),
    })),
  };
}

function coercePlannerDecision(value: unknown): unknown {
  if (!value || typeof value !== "object") {
    return value;
  }
  const record = { ...(value as Record<string, unknown>) };
  const toolName = typeof record.tool_name === "string" ? record.tool_name : null;
  const args = record.args;
  const answer = typeof record.answer === "string" ? record.answer : null;

  if ((!record.type || record.type === "tool") && toolName && VALID_TOOL_NAMES.has(toolName as ToolName)) {
    return {
      ...record,
      type: "tool_call",
      tool_name: toolName,
      args: args && typeof args === "object" ? args : {},
    };
  }

  if (!record.type && answer) {
    return {
      ...record,
      type: "final_answer",
      citations: Array.isArray(record.citations) ? record.citations : [],
    };
  }

  return record;
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

function workspaceMode(context: PlannerContext): "open_book_analysis" | "exhaustive_corpus_search" {
  return context.workScope?.length ? "open_book_analysis" : "exhaustive_corpus_search";
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

function metadataWorks(context: PlannerContext): WorkSummary[] {
  const metadataResult = context.toolHistory.find((item) => item.toolName === "get_work_metadata")?.result;
  return Array.isArray(metadataResult?.works) ? metadataResult.works as WorkSummary[] : [];
}

function searchWorks(context: PlannerContext): WorkSummary[] {
  const searchResult = context.toolHistory.find((item) => item.toolName === "search_works")?.result;
  return Array.isArray(searchResult?.works) ? searchResult.works as WorkSummary[] : [];
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

function buildTaskContext(context: PlannerContext, workIds: string[], chunks: ChunkSearchResult[]) {
  return {
    question: context.userMessage,
    mode: workspaceMode(context),
    candidateWorkIds: workIds,
    topChunks: chunks.slice(0, 12).map((chunk) => ({
      chunkId: chunk.id,
      workId: chunk.workId,
      excerpt: chunk.excerpt,
    })),
  };
}

function buildWorkspaceTaskSpec(context: PlannerContext, workIds: string[], chunks: ChunkSearchResult[]) {
  const metadata = metadataWorks(context);
  const search = searchWorks(context);
  return {
    kind: "briefing_search",
    phase: "collect_and_brief",
    question: context.userMessage,
    mode: workspaceMode(context),
    workIds,
    chunkIds: chunks.slice(0, 24).map((chunk) => chunk.id),
    candidateWorkIds: workIds,
    retrieval: {
      searchWorks: search.slice(0, 12).map((work) => ({
        id: work.id,
        title: work.title,
        authors: work.authors ?? [],
        summary: work.summary ?? null,
        subjects: work.subjects ?? [],
        gutenbergId: work.gutenbergId ?? null,
      })),
      metadataWorks: metadata.slice(0, 12).map((work) => ({
        id: work.id,
        title: work.title,
        authors: work.authors ?? [],
        summary: work.summary ?? null,
        subjects: work.subjects ?? [],
        gutenbergId: work.gutenbergId ?? null,
      })),
      seedChunks: chunks.slice(0, 16).map((chunk) => ({
        id: chunk.id,
        workId: chunk.workId,
        chunkIndex: chunk.chunkIndex,
        excerpt: chunk.excerpt,
        r2Key: chunk.r2Key ?? null,
      })),
    },
    evidenceFile: "output/evidence.json",
    evidenceNotesFile: "output/evidence-notes.md",
    briefingFile: "output/briefing.md",
    briefingJsonFile: "output/briefing.json",
  };
}

export class FallbackPlanner implements Planner {
  async decide(context: PlannerContext): Promise<PlannerDecision> {
    const toolNames = [
      ...context.toolHistory.map((item) => item.toolName),
      ...(context.pendingTools ?? []).map((item) => item.toolName),
    ];
    const scopedWorkIds = context.workScope?.length ? context.workScope : [];
    const chunks = seedChunkPayload(context);
    const metadataIds = scopedWorkIds.length > 0 ? scopedWorkIds.slice(0, 12) : metadataWorkIds(context, 12);
    const workIds = Array.from(new Set([
      ...metadataIds,
      ...chunks.map((chunk) => chunk.workId),
    ])).slice(0, 12);

    if (!toolNames.includes("create_workspace")) {
      return {
        type: "tool_call",
        tool_name: "create_workspace",
        rationale: scopedWorkIds.length > 0
          ? "Starting the Codex workspace for this book first, then I’ll seed it with passages before running the deeper search."
          : "Starting the Codex workspace first, then I’ll seed it with corpus retrieval before running the deeper search.",
        args: {
          workIds: scopedWorkIds.length > 0 ? scopedWorkIds.slice(0, 12) : [],
          chunkIds: [],
          taskContext: buildTaskContext(context, workIds, chunks),
        },
      };
    }

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
        rationale: "The workspace is ready and seeded, so I’m running Codex over the corpus now.",
        args: {
          runtimeId,
          taskSpec: buildWorkspaceTaskSpec(context, workIds, chunks),
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
    const modelContext = summarizePlannerContext(context);
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
            context: modelContext,
            plannerNotes: context.workScope?.length
              ? "A workScope is present. Stay inside those work IDs unless the user explicitly asks to widen scope."
              : (context.pendingTools ?? []).some((entry) => entry.toolName === "create_workspace")
                ? "The workspace startup is already running in the background. Do not start it again; continue with non-runtime retrieval steps until a runtimeId is available."
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
        throw new Error("Planner timed out before choosing the next step.");
      }
      throw error;
    }
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
    const parsedJson = parseModelJsonObject<unknown>(content);
    const parsedCandidate = coercePlannerDecision(parsedJson);
    const parsedResult = PlannerDecisionSchema.safeParse(parsedCandidate);
    if (!parsedResult.success) {
      const fallbackPlanner = new FallbackPlanner();
      return fallbackPlanner.decide(context);
    }
    const parsed = parsedResult.data;
    if (!context.toolHistory.some((entry) => entry.toolName === "create_workspace")) {
      const chunks = seedChunkPayload(context);
      const metadataIds = context.workScope?.length ? context.workScope.slice(0, 12) : metadataWorkIds(context, 12);
      const workIds = Array.from(new Set([
        ...metadataIds,
        ...chunks.map((chunk) => chunk.workId),
      ])).slice(0, 12);
      return {
        type: "tool_call",
        tool_name: "create_workspace",
        rationale: context.workScope?.length
          ? "I’m starting the Codex workspace for this book first, then I’ll seed it with retrieval before the full search."
          : "I’m starting the Codex workspace first, then I’ll seed it with retrieval before the full search.",
        args: {
          workIds: context.workScope?.length ? context.workScope.slice(0, 12) : [],
          chunkIds: [],
          taskContext: buildTaskContext(context, workIds, chunks),
        },
      };
    }
    return parsed;
  }
}

export function parseToolCall(decision: PlannerDecision): PlannerToolCall | null {
  return decision.type === "tool_call" ? decision : null;
}
