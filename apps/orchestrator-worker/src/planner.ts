import { HARD_LIMITS } from "@alphabook/corpus-core";
import {
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
  mode?: "semantic" | "comprehensive";
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

type ResearchIntent =
  | "broad_evidence_survey"
  | "hypothesis_test"
  | "follow_up_refinement"
  | "comparison"
  | "verification"
  | "counterexample_search";

const VALID_TOOL_NAMES = new Set<ToolName>([
  "semantic_deep_search",
  "estimate_research_scope",
  "search_works",
  "get_work_metadata",
  "get_relevant_chunks",
  "classify_candidate_chunks",
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
    case "semantic_deep_search": {
      const chunks = Array.isArray(result.chunks) ? result.chunks as Array<Record<string, unknown>> : [];
      return {
        chunkCount: chunks.length,
        totalChunksConsidered: typeof result.totalChunksConsidered === "number" ? result.totalChunksConsidered : null,
        briefingPreview: typeof result.briefing === "string" ? truncateForModel(result.briefing, 220) : null,
        chunks: chunks.slice(0, 6).map((chunk) => ({
          id: typeof chunk.id === "string" ? chunk.id : null,
          workId: typeof chunk.workId === "string" ? chunk.workId : null,
          chunkIndex: typeof chunk.chunkIndex === "number" ? chunk.chunkIndex : null,
          excerpt: typeof chunk.excerpt === "string" ? truncateForModel(chunk.excerpt, 180) : null,
        })),
      };
    }
    case "estimate_research_scope":
      return {
        scopeMode: typeof result.scopeMode === "string" ? result.scopeMode : null,
        metadataWorkEstimate: typeof result.metadataWorkEstimate === "number" ? result.metadataWorkEstimate : null,
        chunkMatchEstimate: typeof result.chunkMatchEstimate === "number" ? result.chunkMatchEstimate : null,
        chunkWorkEstimate: typeof result.chunkWorkEstimate === "number" ? result.chunkWorkEstimate : null,
        totalWorkEstimate: typeof result.totalWorkEstimate === "number" ? result.totalWorkEstimate : null,
        totalChunkEstimate: typeof result.totalChunkEstimate === "number" ? result.totalChunkEstimate : null,
        totalTextBytesEstimate: typeof result.totalTextBytesEstimate === "number" ? result.totalTextBytesEstimate : null,
        breadthBand: typeof result.breadthBand === "string" ? result.breadthBand : null,
        recommendedIntensity: typeof result.recommendedIntensity === "string" ? result.recommendedIntensity : null,
        recommendedWallClockMinutes: typeof result.recommendedWallClockMinutes === "number" ? result.recommendedWallClockMinutes : null,
        recommendedParallelism: typeof result.recommendedParallelism === "number" ? result.recommendedParallelism : null,
        recommendedShardAxis: typeof result.recommendedShardAxis === "string" ? result.recommendedShardAxis : null,
        rationale: typeof result.rationale === "string" ? truncateForModel(result.rationale, 220) : null,
      };
    case "search_works": {
      const frontier = result.frontier && typeof result.frontier === "object"
        ? result.frontier as Record<string, unknown>
        : null;
      const works = Array.isArray(frontier?.works)
        ? frontier.works as Array<Record<string, unknown>>
        : Array.isArray(result.works) ? result.works as Array<Record<string, unknown>> : [];
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
    case "classify_candidate_chunks": {
      const chunks = Array.isArray(result.chunks) ? result.chunks as Array<Record<string, unknown>> : [];
      const relevantWorkIds = Array.isArray(result.relevantWorkIds) ? result.relevantWorkIds : [];
      return {
        relevantChunkCount: chunks.length,
        relevantWorkCount: relevantWorkIds.length,
        chunks: chunks.slice(0, 6).map((chunk) => ({
          id: typeof chunk.id === "string" ? chunk.id : null,
          workId: typeof chunk.workId === "string" ? chunk.workId : null,
          chunkIndex: typeof chunk.chunkIndex === "number" ? chunk.chunkIndex : null,
          relevanceScore: typeof chunk.relevanceScore === "number" ? chunk.relevanceScore : null,
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
    mode: context.mode ?? "semantic",
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
  return /\b(compare|comparison|contrast|versus|vs\.?|between)\b/i.test(query);
}

function latestAssistantContent(context: PlannerContext) {
  for (let index = context.conversationHistory.length - 1; index >= 0; index -= 1) {
    const entry = context.conversationHistory[index];
    if (entry.role === "assistant" && entry.content.trim().length > 0) {
      return entry.content.trim();
    }
  }
  return null;
}

function latestUserContents(context: PlannerContext, limit = 3) {
  const userMessages = context.conversationHistory
    .filter((entry) => entry.role === "user" && entry.content.trim().length > 0)
    .map((entry) => entry.content.trim());
  return userMessages.slice(-limit);
}

function classifyResearchIntent(context: PlannerContext): ResearchIntent {
  const query = context.userMessage.trim();
  const lowered = query.toLowerCase();
  const priorUserMessages = latestUserContents(context, 4);
  const hasPriorTurns = context.conversationHistory.length > 0;

  if (/\b(counterexample|counter-example|exception|exceptions|disconfirm|disprove|contradict|against the claim)\b/i.test(query)) {
    return "counterexample_search";
  }
  if (
    /\b(hypothesis|test whether|for and against|support and oppose|support or refute|prove or disprove|final verdict|verdict)\b/i.test(query)
    || /\bis (?:it|this|that) true\b/i.test(query)
  ) {
    return "hypothesis_test";
  }
  if (/\b(verify|verification|check whether|are we sure|double-check|validate)\b/i.test(query)) {
    return "verification";
  }
  if (
    /\b(all the ways|different ways|ways that|kinds of|types of|examples of|forms of|patterns of)\b/i.test(query)
    || /\b(find|identify|survey|trace|catalog|collect)\b/i.test(query)
  ) {
    return "broad_evidence_survey";
  }
  if (isComparisonQuery(query)) {
    return "comparison";
  }
  if (
    hasPriorTurns
    && (
      /^(what about|and what about|now|next|more|go deeper|dig deeper|narrow|zoom in|follow up|follow-up|expand on|focus on|what else)\b/i.test(query)
      || (query.length <= 120 && /\b(that|those|it|them|this|these|previous|last run|earlier answer)\b/i.test(lowered))
      || priorUserMessages.length > 1
    )
  ) {
    return "follow_up_refinement";
  }
  return "broad_evidence_survey";
}

function buildSearchHints(context: PlannerContext, taskIntent: ResearchIntent) {
  const priorAssistant = latestAssistantContent(context);
  const baseFocus = "Find the strongest directly quotable passages that best answer the research objective.";
  switch (taskIntent) {
    case "hypothesis_test":
      return {
        passageSearchFocus: `${context.userMessage} Focus on directly quotable evidence that supports or challenges the hypothesis.`,
        supportingEvidenceFocus: `Find direct passages that support this hypothesis: ${context.userMessage}`,
        opposingEvidenceFocus: `Find direct passages that challenge or complicate this hypothesis: ${context.userMessage}`,
        synthesisMode: "verdict",
      };
    case "counterexample_search":
      return {
        passageSearchFocus: `${context.userMessage} Focus on exceptions, edge cases, and disconfirming evidence.`,
        opposingEvidenceFocus: `Find direct passages that complicate or weaken the apparent pattern in: ${context.userMessage}`,
        synthesisMode: "counterexample_scan",
      };
    case "verification":
      return {
        passageSearchFocus: `${context.userMessage} Focus on directly checking whether the prior claim is actually supported by quoted evidence.`,
        verificationFocus: priorAssistant ? truncateForModel(priorAssistant, 220) : context.userMessage,
        synthesisMode: "verification",
      };
    case "comparison":
      return {
        passageSearchFocus: `${context.userMessage} Focus on directly comparable passages across the strongest candidate books.`,
        synthesisMode: "comparison",
      };
    case "follow_up_refinement":
      return {
        passageSearchFocus: `${context.userMessage} Reuse the prior strongest evidence first, then fill the most obvious gaps.`,
        priorAnswerFocus: priorAssistant ? truncateForModel(priorAssistant, 220) : null,
        synthesisMode: "follow_up",
      };
    case "broad_evidence_survey":
    default:
      return {
        passageSearchFocus: baseFocus,
        synthesisMode: "survey",
      };
  }
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
  return searchFrontierWorks(context).slice(0, limit).map((work) => work.id);
}

function metadataWorks(context: PlannerContext): WorkSummary[] {
  const metadataResult = context.toolHistory.find((item) => item.toolName === "get_work_metadata")?.result;
  return Array.isArray(metadataResult?.works) ? metadataResult.works as WorkSummary[] : [];
}

function isBroadCorpusQuery(context: PlannerContext): boolean {
  return workspaceMode(context) === "exhaustive_corpus_search"
    && needsWorkspaceSearch(context.userMessage, context.workScope ?? [], seedChunkPayload(context).length);
}

function searchWorks(context: PlannerContext): WorkSummary[] {
  const searchResult = context.toolHistory.find((item) => item.toolName === "search_works")?.result;
  return Array.isArray(searchResult?.works) ? searchResult.works as WorkSummary[] : [];
}

function searchFrontierWorks(context: PlannerContext): WorkSummary[] {
  const searchResult = context.toolHistory.find((item) => item.toolName === "search_works")?.result;
  const frontier = searchResult?.frontier && typeof searchResult.frontier === "object"
    ? searchResult.frontier as Record<string, unknown>
    : null;
  return Array.isArray(frontier?.works)
    ? frontier.works as WorkSummary[]
    : searchWorks(context);
}

function uniqueWorkIds(values: Array<string | null | undefined>, limit = 256): string[] {
  const seen = new Set<string>();
  const ordered: string[] = [];
  for (const value of values) {
    if (!value || seen.has(value)) {
      continue;
    }
    seen.add(value);
    ordered.push(value);
    if (ordered.length >= limit) {
      break;
    }
  }
  return ordered;
}

function frontierWorkIds(context: PlannerContext, seedWorkIds: string[], chunks: ChunkSearchResult[], limit: number): string[] {
  const searchResults = searchFrontierWorks(context);
  const metadataResults = metadataWorks(context);
  const chunkWorkIds = chunks.map((chunk) => chunk.workId);
  return uniqueWorkIds([
    ...seedWorkIds,
    ...chunkWorkIds,
    ...searchResults.map((work) => work.id),
    ...metadataResults.map((work) => work.id),
  ], limit);
}

function classifiedChunkPayload(context: PlannerContext): ChunkSearchResult[] {
  const classifyResult = context.toolHistory.find((item) => item.toolName === "classify_candidate_chunks")?.result;
  return (classifyResult?.chunks as ChunkSearchResult[] | undefined) ?? [];
}

function classifyFailureMessage(context: PlannerContext): string | null {
  const classifyResult = context.toolHistory.find((item) => item.toolName === "classify_candidate_chunks")?.result;
  if (classifyResult?.ok === false && typeof classifyResult.error === "string" && classifyResult.error.trim().length > 0) {
    return classifyResult.error;
  }
  return null;
}

function verifiedWorkIds(chunks: ChunkSearchResult[], limit = 256): string[] {
  return uniqueWorkIds(chunks.map((chunk) => chunk.workId), limit);
}

function candidateWorkIds(
  context: PlannerContext,
  frontierIds: string[],
  chunks: ChunkSearchResult[],
  limit: number,
): string[] {
  const searchResults = searchWorks(context);
  const metadataResults = metadataWorks(context);
  return uniqueWorkIds([
    ...verifiedWorkIds(chunks, limit),
    ...metadataResults.map((work) => work.id),
    ...searchResults.map((work) => work.id),
    ...frontierIds,
  ], limit);
}

function seedChunkPayload(context: PlannerContext): ChunkSearchResult[] {
  const classified = classifiedChunkPayload(context);
  if (classified.length > 0) {
    return classified;
  }
  const chunkResult = context.toolHistory.find((item) => item.toolName === "get_relevant_chunks")?.result;
  return (chunkResult?.chunks as ChunkSearchResult[] | undefined) ?? [];
}

function scopeEstimate(context: PlannerContext): Record<string, unknown> | null {
  for (let index = context.toolHistory.length - 1; index >= 0; index -= 1) {
    const entry = context.toolHistory[index];
    if (entry.toolName === "estimate_research_scope") {
      return entry.result;
    }
  }
  return null;
}

function estimateNumber(result: Record<string, unknown> | null, key: string, fallback: number) {
  return typeof result?.[key] === "number" ? Number(result[key]) : fallback;
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

function hasToolStarted(context: PlannerContext, toolName: ToolName): boolean {
  return context.toolHistory.some((entry) => entry.toolName === toolName)
    || (context.pendingTools ?? []).some((entry) => entry.toolName === toolName);
}

function lastToolCall(context: PlannerContext): PlannerContext["toolHistory"][number] | null {
  return context.toolHistory.length > 0 ? context.toolHistory[context.toolHistory.length - 1] : null;
}

function buildTaskContext(context: PlannerContext, workIds: string[], chunks: ChunkSearchResult[]) {
  const broadCorpusQuery = isBroadCorpusQuery(context);
  const taskIntent = classifyResearchIntent(context);
  const estimate = scopeEstimate(context);
  const followUpContext = taskIntent === "follow_up_refinement" || taskIntent === "verification" || taskIntent === "counterexample_search"
    ? {
        priorUserMessages: latestUserContents(context, 3),
        priorAssistantSummary: latestAssistantContent(context)
          ? truncateForModel(latestAssistantContent(context) as string, 220)
          : null,
      }
    : null;
  const recommendedFrontierWorks = estimateNumber(estimate, "recommendedFrontierWorks", broadCorpusQuery ? 24 : 12);
  const candidateLimit = broadCorpusQuery
    ? Math.max(24, Math.min(40, Math.ceil(recommendedFrontierWorks / 3)))
    : Math.max(12, Math.min(18, recommendedFrontierWorks));
  const frontierIds = frontierWorkIds(context, workIds, chunks, Math.max(broadCorpusQuery ? 96 : 32, recommendedFrontierWorks));
  const verifiedIds = verifiedWorkIds(chunks, Math.max(broadCorpusQuery ? 64 : 20, recommendedFrontierWorks));
  const narrowedCandidateIds = candidateWorkIds(
    context,
    frontierIds,
    chunks,
    candidateLimit,
  );
  const recommendedShards = estimate && Array.isArray(estimate.recommendedShards)
    ? estimate.recommendedShards.slice(0, 16)
    : [];
  return {
    question: context.userMessage,
    researchObjective: context.userMessage,
    taskIntent,
    mode: workspaceMode(context),
    followUpContext,
    candidateWorkIds: narrowedCandidateIds,
    frontierWorkIds: frontierIds,
    verifiedWorkIds: verifiedIds,
    verifiedChunkIds: chunks.slice(0, broadCorpusQuery ? 48 : 20).map((chunk) => chunk.id),
    searchPlan: estimate
      ? {
          intensity: typeof estimate.recommendedIntensity === "string" ? estimate.recommendedIntensity : null,
          wallClockMinutes: typeof estimate.recommendedWallClockMinutes === "number" ? estimate.recommendedWallClockMinutes : null,
          parallelism: typeof estimate.recommendedParallelism === "number" ? estimate.recommendedParallelism : null,
          shardAxis: typeof estimate.recommendedShardAxis === "string" ? estimate.recommendedShardAxis : null,
          breadthBand: typeof estimate.breadthBand === "string" ? estimate.breadthBand : null,
          frontierWorks: typeof estimate.recommendedFrontierWorks === "number" ? estimate.recommendedFrontierWorks : null,
          shards: recommendedShards,
        }
      : null,
    topChunks: chunks.slice(0, broadCorpusQuery ? 24 : 12).map((chunk) => ({
      chunkId: chunk.id,
      workId: chunk.workId,
      excerpt: chunk.excerpt,
    })),
  };
}

function buildWorkspaceTaskSpec(context: PlannerContext, workIds: string[], chunks: ChunkSearchResult[]) {
  const broadCorpusQuery = isBroadCorpusQuery(context);
  const taskIntent = classifyResearchIntent(context);
  const estimate = scopeEstimate(context);
  const followUpContext = taskIntent === "follow_up_refinement" || taskIntent === "verification" || taskIntent === "counterexample_search"
    ? {
        priorUserMessages: latestUserContents(context, 3),
        priorAssistantSummary: latestAssistantContent(context)
          ? truncateForModel(latestAssistantContent(context) as string, 220)
          : null,
      }
    : null;
  const recommendedFrontierWorks = estimateNumber(estimate, "recommendedFrontierWorks", broadCorpusQuery ? 32 : 12);
  const recommendedParallelism = estimateNumber(estimate, "recommendedParallelism", broadCorpusQuery ? 2 : 1);
  const workLimit = broadCorpusQuery
    ? Math.max(32, Math.min(48, Math.ceil(recommendedFrontierWorks * 0.75)))
    : Math.max(12, Math.min(18, recommendedFrontierWorks));
  const chunkLimit = Math.max(broadCorpusQuery ? 72 : 24, Math.min(128, recommendedFrontierWorks * 2));
  const seedChunkLimit = Math.max(broadCorpusQuery ? 56 : 16, Math.min(96, recommendedFrontierWorks));
  const metadata = metadataWorks(context);
  const search = searchWorks(context);
  const searchFrontier = searchFrontierWorks(context);
  const frontierIds = frontierWorkIds(context, workIds, chunks, Math.max(broadCorpusQuery ? 96 : 32, recommendedFrontierWorks));
  const verifiedIds = verifiedWorkIds(chunks, workLimit);
  const narrowedCandidateIds = candidateWorkIds(context, frontierIds, chunks, workLimit);
  const recommendedShards = estimate && Array.isArray(estimate.recommendedShards)
    ? estimate.recommendedShards.slice(0, 16)
    : [];
  return {
    kind: "briefing_search",
    phase: "collect_and_brief",
    question: context.userMessage,
    researchObjective: context.userMessage,
    taskIntent,
    followUpContext,
    mode: workspaceMode(context),
    intensity: typeof estimate?.recommendedIntensity === "string" ? estimate.recommendedIntensity : broadCorpusQuery ? "high" : "normal",
    timeBudgetMinutes: typeof estimate?.recommendedWallClockMinutes === "number" ? estimate.recommendedWallClockMinutes : broadCorpusQuery ? 15 : 5,
    parallelism: recommendedParallelism,
    shardAxis: typeof estimate?.recommendedShardAxis === "string" ? estimate.recommendedShardAxis : broadCorpusQuery ? "work_id_hash" : "none",
    workIds: narrowedCandidateIds,
    chunkIds: chunks.slice(0, chunkLimit).map((chunk) => chunk.id),
    candidateWorkIds: narrowedCandidateIds,
    frontierWorkIds: frontierIds,
    verifiedWorkIds: verifiedIds,
    verifiedChunkIds: chunks.slice(0, chunkLimit).map((chunk) => chunk.id),
    shardPlan: recommendedShards,
    searchHints: {
      searchWorksQuery: context.userMessage,
      ...buildSearchHints(context, taskIntent),
    },
    searchPlan: estimate ?? undefined,
    retrieval: {
      frontierWorks: searchFrontier.slice(0, Math.max(workLimit, recommendedFrontierWorks)).map((work) => ({
        id: work.id,
        title: work.title,
        authors: work.authors ?? [],
        summary: work.summary ?? null,
        subjects: work.subjects ?? [],
        gutenbergId: work.gutenbergId ?? null,
      })),
      searchWorks: search.slice(0, Math.max(workLimit, recommendedFrontierWorks)).map((work) => ({
        id: work.id,
        title: work.title,
        authors: work.authors ?? [],
        summary: work.summary ?? null,
        subjects: work.subjects ?? [],
        gutenbergId: work.gutenbergId ?? null,
      })),
      metadataWorks: metadata.slice(0, Math.max(workLimit, recommendedFrontierWorks)).map((work) => ({
        id: work.id,
        title: work.title,
        authors: work.authors ?? [],
        summary: work.summary ?? null,
        subjects: work.subjects ?? [],
        gutenbergId: work.gutenbergId ?? null,
      })),
      seedChunks: chunks.slice(0, seedChunkLimit).map((chunk) => ({
        id: chunk.id,
        workId: chunk.workId,
        chunkIndex: chunk.chunkIndex,
        excerpt: chunk.excerpt,
        r2Key: chunk.r2Key ?? null,
      })),
      verifiedChunks: chunks.slice(0, chunkLimit).map((chunk) => ({
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
    if (context.mode === "semantic") {
      return {
        type: "tool_call",
        tool_name: "semantic_deep_search",
        rationale: "I’m running the semantic retrieval loop directly against the vector index and writing the answer from the strongest passages.",
        args: {
          query: context.userMessage,
          ...(context.workScope?.length ? { workIds: context.workScope.slice(0, 80) } : {}),
          maxResults: 8,
        },
      };
    }
    const broadCorpusQuery = isBroadCorpusQuery(context);
    const classifyFailure = classifyFailureMessage(context);
    const estimate = scopeEstimate(context);
    const metadataLimit = Math.max(broadCorpusQuery ? 40 : 12, Math.min(60, estimateNumber(estimate, "recommendedFrontierWorks", broadCorpusQuery ? 40 : 12)));
    const workLimit = broadCorpusQuery
      ? Math.max(16, Math.min(24, Math.ceil(estimateNumber(estimate, "recommendedFrontierWorks", 64) / 4)))
      : Math.max(12, Math.min(16, estimateNumber(estimate, "recommendedFrontierWorks", 12)));
    const toolNames = [
      ...context.toolHistory.map((item) => item.toolName),
      ...(context.pendingTools ?? []).map((item) => item.toolName),
    ];
    const scopedWorkIds = context.workScope?.length ? context.workScope : [];
    const chunks = seedChunkPayload(context);
    const metadataIds = scopedWorkIds.length > 0 ? scopedWorkIds.slice(0, metadataLimit) : metadataWorkIds(context, metadataLimit);
    const frontierIds = frontierWorkIds(context, metadataIds, chunks, Math.max(workLimit, metadataLimit));
    const workIds = candidateWorkIds(context, frontierIds, chunks, workLimit);

    if (!toolNames.includes("search_works")) {
      return {
        type: "tool_call",
        tool_name: "search_works",
        rationale: "Surfacing likely books immediately so the research document starts filling with candidate evidence while the deeper search is prepared.",
        args: {
          query: context.userMessage,
          filters: {
            limit: metadataLimit,
          },
        },
      };
    }

    if (!toolNames.includes("get_relevant_chunks")) {
      return {
        type: "tool_call",
        tool_name: "get_relevant_chunks",
        rationale: scopedWorkIds.length > 0
          ? "Pulling a broad candidate passage set inside the current book scope before I filter down to the truly relevant evidence."
          : "Pulling a broad candidate passage set from the surfaced books before I filter down to the truly relevant evidence.",
        args: {
          query: context.userMessage,
          ...(frontierIds.length > 0 ? { workIds: frontierIds } : {}),
          filters: {
            limit: broadCorpusQuery ? 768 : 160,
          },
        },
      };
    }

    if (!toolNames.includes("classify_candidate_chunks")) {
      const candidateChunks = seedChunkPayload(context);
      if (candidateChunks.length > 0) {
        return {
          type: "tool_call",
          tool_name: "classify_candidate_chunks",
          rationale: "Filtering the broad candidate passage pool down to the chunks that are actually relevant before I size the job and start the heavy research run.",
          args: {
            query: context.userMessage,
            chunkIds: candidateChunks.map((chunk) => chunk.id).slice(0, broadCorpusQuery ? 3000 : 1000),
            maxRelevantChunks: broadCorpusQuery ? 240 : 96,
            maxRelevantWorks: broadCorpusQuery ? 80 : 24,
          },
        };
      }
    }

    if (broadCorpusQuery && classifyFailure) {
      return {
        type: "final_answer",
        answer: `The relevance filter failed, so I stopped instead of continuing with an unvetted passage pool. Error: ${classifyFailure}`,
        citations: [],
      };
    }

    if (!toolNames.includes("estimate_research_scope")) {
      const candidateChunks = seedChunkPayload(context);
      return {
        type: "tool_call",
        tool_name: "estimate_research_scope",
        rationale: "Sizing the vetted evidence set so I can choose the right shard count, wall-clock budget, and workspace plan from relevant chunks instead of metadata alone.",
        args: {
          query: context.userMessage,
          ...(candidateChunks.length > 0
            ? {
                chunkIds: candidateChunks.map((chunk) => chunk.id).slice(0, broadCorpusQuery ? 240 : 96),
                workIds: verifiedWorkIds(candidateChunks, broadCorpusQuery ? 80 : 24),
              }
            : {}),
        },
      };
    }

    if (!toolNames.includes("create_workspace")) {
      return {
        type: "tool_call",
        tool_name: "create_workspace",
        rationale: scopedWorkIds.length > 0
          ? "Starting the Codex workspace for this book with the estimated search budget after the first visible metadata pass."
          : "Starting the Codex workspace with the estimated search budget after the first visible metadata pass.",
        args: {
          workIds: scopedWorkIds.length > 0 ? scopedWorkIds.slice(0, 12) : [],
          chunkIds: [],
          taskContext: buildTaskContext(context, workIds, chunks),
        },
      };
    }

    if (!toolNames.includes("get_work_metadata") && metadataIds.length > 0) {
      return {
        type: "tool_call",
        tool_name: "get_work_metadata",
        rationale: "Loading metadata for the strongest frontier books after the first direct passage verification pass.",
        args: {
          workIds: metadataIds,
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
    private readonly systemPrompt: string = PLANNER_SYSTEM_PROMPT,
  ) {}

  async decide(context: PlannerContext): Promise<PlannerDecision> {
    if (context.mode === "semantic") {
      return {
        type: "tool_call",
        tool_name: "semantic_deep_search",
        rationale: "I’m running the semantic retrieval loop directly against the vector index and writing the answer from the strongest passages.",
        args: {
          query: context.userMessage,
          ...(context.workScope?.length ? { workIds: context.workScope.slice(0, 80) } : {}),
          maxResults: 8,
        },
      };
    }
    const modelContext = summarizePlannerContext(context);
    const broadCorpusQuery = isBroadCorpusQuery(context);
    const classifyFailure = classifyFailureMessage(context);
    const body = {
      model: this.model,
      response_format: { type: "json_object" as const },
      messages: [
        {
          role: "system",
          content: `${this.systemPrompt}\nReturn a single JSON object that matches the requested output shape.`,
        },
        {
          role: "user",
          content: JSON.stringify({
            task: "Choose the next AlphaBook action.",
            responseInstructions: "Reply with JSON only.",
            hardLimits: HARD_LIMITS,
            availableTools: [
              "estimate_research_scope(query, filters?)",
              "search_works(query, filters?)",
              "get_work_metadata(work_ids)",
              "get_relevant_chunks(query, work_ids?, filters?)",
              "classify_candidate_chunks(query, chunk_ids, max_relevant_chunks?, max_relevant_works?)",
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
    if (!hasToolStarted(context, "search_works")) {
      return {
        type: "tool_call",
        tool_name: "search_works",
        rationale: "I’m surfacing likely books immediately so the research document starts filling before the deeper workspace search begins.",
        args: {
          query: context.userMessage,
          filters: {
            limit: 24,
          },
        },
      };
    }
    if (!hasToolStarted(context, "get_relevant_chunks")) {
      const metadataIds = context.workScope?.length ? context.workScope.slice(0, 24) : metadataWorkIds(context, 24);
      return {
        type: "tool_call",
        tool_name: "get_relevant_chunks",
        rationale: context.workScope?.length
          ? "I’m pulling a broad candidate passage set inside the current book scope before I filter down to the truly relevant evidence."
          : "I’m pulling a broad candidate passage set from the surfaced books before I filter down to the truly relevant evidence.",
        args: {
          query: context.userMessage,
          ...(metadataIds.length > 0 ? { workIds: metadataIds } : {}),
          filters: {
            limit: isBroadCorpusQuery(context) ? 768 : 160,
          },
        },
      };
    }
    if (!hasToolStarted(context, "classify_candidate_chunks")) {
      const candidateChunks = seedChunkPayload(context);
      if (candidateChunks.length > 0) {
        return {
          type: "tool_call",
          tool_name: "classify_candidate_chunks",
          rationale: "I’m filtering the broad candidate passage pool down to the chunks that are actually relevant before I size the heavy research run.",
          args: {
            query: context.userMessage,
            chunkIds: candidateChunks.map((chunk) => chunk.id).slice(0, 1000),
            maxRelevantChunks: 96,
            maxRelevantWorks: 24,
          },
        };
      }
    }
    if (broadCorpusQuery && classifyFailure) {
      return {
        type: "final_answer",
        answer: `The relevance filter failed, so I stopped instead of continuing with an unvetted passage pool. Error: ${classifyFailure}`,
        citations: [],
      };
    }
    if (!hasToolStarted(context, "estimate_research_scope")) {
      const chunks = seedChunkPayload(context);
      return {
        type: "tool_call",
        tool_name: "estimate_research_scope",
        rationale: "I’m sizing the vetted evidence set so I can choose the right time budget and shard plan from relevant chunks instead of metadata alone.",
        args: {
          query: context.userMessage,
          ...(chunks.length > 0
            ? {
                chunkIds: chunks.map((chunk) => chunk.id).slice(0, 240),
                workIds: verifiedWorkIds(chunks, 80),
              }
            : {}),
        },
      };
    }
    if (!hasToolStarted(context, "create_workspace")) {
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
          ? "I’m starting the Codex workspace for this book after the first visible metadata pass."
          : "I’m starting the Codex workspace after the first visible metadata pass.",
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
