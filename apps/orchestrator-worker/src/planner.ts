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

export class FallbackPlanner implements Planner {
  async decide(context: PlannerContext): Promise<PlannerDecision> {
    const toolNames = context.toolHistory.map((item) => item.toolName);
    if (!toolNames.includes("search_works")) {
      return {
        type: "tool_call",
        tool_name: "search_works",
        rationale: "I’ll start by searching the corpus for likely books, then pull the strongest passages before deciding whether a deeper workspace search is necessary.",
        args: {
          query: context.userMessage,
          filters: {
            limit: 5,
          },
        },
      };
    }

    const searchResult = context.toolHistory.find((item) => item.toolName === "search_works");
    const workIds = ((searchResult?.result.works as WorkSummary[] | undefined) ?? []).slice(0, 3).map((work) => work.id);

    if (!toolNames.includes("get_relevant_chunks")) {
      return {
        type: "tool_call",
        tool_name: "get_relevant_chunks",
        rationale: "I found candidate books. Next I’m pulling the strongest passages so the answer is grounded in actual text.",
        args: {
          query: context.userMessage,
          workIds,
          filters: {
            limit: 6,
          },
        },
      };
    }

    const chunkResult = context.toolHistory.find((item) => item.toolName === "get_relevant_chunks");
    const chunks = (chunkResult?.result.chunks as ChunkSearchResult[] | undefined) ?? [];
    if (!chunks.length) {
      return {
        type: "final_answer",
        answer: "I could not find enough evidence in the current corpus to answer that yet.",
        citations: [],
      };
    }

    if (needsWorkspaceSearch(context.userMessage, workIds, chunks.length)) {
      if (!toolNames.includes("create_workspace")) {
        return {
          type: "tool_call",
          tool_name: "create_workspace",
          rationale: "The retrieval pass is not enough on its own, so I’m preparing a workspace with the relevant books and passages for a deeper local search.",
          args: {
            workIds: workIds.slice(0, 3),
            chunkIds: chunks.slice(0, 8).map((chunk) => chunk.id),
            taskContext: {
              question: context.userMessage,
              mode: "corpus_search",
              topChunks: chunks.slice(0, 6).map((chunk) => ({
                chunkId: chunk.id,
                workId: chunk.workId,
                excerpt: chunk.excerpt,
              })),
            },
          },
        };
      }

      if (!toolNames.includes("run_workspace_task")) {
        const runtimeId = context.toolHistory.find((item) => item.toolName === "create_workspace")?.result.runtimeId;
        if (typeof runtimeId !== "string") {
          return {
            type: "final_answer",
            answer: "I retrieved evidence, but I could not start a deeper workspace search.",
            citations: extractCitationsFromChunks(chunks),
          };
        }

        return {
          type: "tool_call",
          tool_name: "run_workspace_task",
          rationale: "The workspace is ready. Now I’m running a deeper iterative search over the local corpus files to compare evidence across books.",
          args: {
            runtimeId,
            taskSpec: {
              kind: "corpus_search",
              question: context.userMessage,
              workIds: workIds.slice(0, 3),
              chunkIds: chunks.slice(0, 8).map((chunk) => chunk.id),
              outputFile: "output/summary.md",
            },
          },
        };
      }

      if (!toolNames.includes("read_workspace_file")) {
        const runtimeId = context.toolHistory.find((item) => item.toolName === "create_workspace")?.result.runtimeId;
        if (typeof runtimeId !== "string") {
          return {
            type: "final_answer",
            answer: "The workspace search finished, but I could not resolve its runtime.",
            citations: extractCitationsFromChunks(chunks),
          };
        }

        return {
          type: "tool_call",
          tool_name: "read_workspace_file",
          rationale: "The deep workspace search has finished. I’m reading the generated summary back so I can synthesize the answer.",
          args: {
            runtimeId,
            path: "output/summary.md",
          },
        };
      }

      const summary = context.toolHistory.find((item) => item.toolName === "read_workspace_file")?.result.content;
      const answer = typeof summary === "string" && summary.trim().length
        ? summary.slice(0, 1600)
        : "I completed a deeper runtime search after retrieval and gathered enough evidence to answer from the corpus.";
      return {
        type: "final_answer",
        answer,
        citations: extractCitationsFromChunks(chunks),
      };
    }

    const answer = `I found evidence across ${new Set(chunks.map((chunk) => chunk.workId)).size} works. The strongest passages all cluster around the same theme, so I would answer the query from those retrieved chunks first.`;
    return {
      type: "final_answer",
      answer,
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
