import { z } from "zod";

import { HARD_LIMITS } from "@alphabook/corpus-core";
import { ROUTER_SYSTEM_PROMPT } from "@alphabook/shared";

import { openAIUsageFromResponse, type BillingContext, type BillingService } from "./billing";
import { parseModelJsonObject } from "./json";

const RouterDecisionSchema = z.union([
  z.object({
    type: z.literal("direct_response"),
    answer: z.string().min(1),
    workflowHint: z.enum(["search", "design_experiment"]).nullable().optional(),
    experimentProposal: z.object({
      title: z.string().min(1),
      summary: z.string().min(1),
      approvalPrompt: z.string().min(1),
    }).optional(),
  }),
  z.object({
    type: z.literal("search"),
    fullQuery: z.string().min(1),
    rationale: z.string().min(1).optional(),
    executionMode: z.enum(["semantic", "comprehensive", "hermes"]).optional(),
  }),
  z.object({
    type: z.literal("design_experiment"),
    designSummary: z.string().min(1),
    executionPrompt: z.string().min(1),
    rationale: z.string().min(1).optional(),
  }),
]);

export type RouterDecision = z.infer<typeof RouterDecisionSchema>;

export interface RouterContext {
  userMessage: string;
  requestedWorkflow?: "auto" | "search" | "design_experiment";
  conversationHistory: Array<{
    role: "user" | "assistant" | "system" | "tool";
    content: string;
  }>;
  billingContext?: BillingContext;
}

export interface Router {
  decide(context: RouterContext): Promise<RouterDecision>;
}

type LegacyToolChainDecision = {
  type: "tool_chain";
  fullQuery: string;
};

function normalizeWorkflowHint(value: unknown): "search" | "design_experiment" | undefined {
  if (value === "search" || value === "design_experiment") {
    return value;
  }
  if (typeof value !== "string") {
    return undefined;
  }
  const normalized = value.trim().toLowerCase();
  if (!normalized) {
    return undefined;
  }
  if (normalized.includes("design_experiment") || normalized.includes("design experiment") || normalized.includes("experiment")) {
    return "design_experiment";
  }
  if (normalized.includes("search")) {
    return "search";
  }
  return undefined;
}

function coerceRouterDecision(value: unknown): unknown {
  if (!value || typeof value !== "object") {
    return value;
  }
  const record = { ...(value as Record<string, unknown>) };
  const type = typeof record.type === "string" ? record.type : null;
  const workflowHint = normalizeWorkflowHint(record.workflowHint);
  const answer = typeof record.answer === "string" ? record.answer : null;
  const fullQuery = typeof record.fullQuery === "string" ? record.fullQuery : null;
  const designSummary = typeof record.designSummary === "string" ? record.designSummary : null;
  const executionPrompt = typeof record.executionPrompt === "string" ? record.executionPrompt : null;

  if (type === "tool_chain" && fullQuery) {
    return {
      type: "search",
      fullQuery,
      ...(typeof record.rationale === "string" ? { rationale: record.rationale } : {}),
    };
  }

  if (type === "direct_response" && answer) {
    return {
      type,
      answer,
      ...(workflowHint ? { workflowHint } : {}),
      ...(record.experimentProposal && typeof record.experimentProposal === "object" ? { experimentProposal: record.experimentProposal } : {}),
    };
  }

  if (type === "search" && fullQuery) {
    return {
      type,
      fullQuery,
      ...(typeof record.rationale === "string" ? { rationale: record.rationale } : {}),
      ...((record.executionMode === "semantic" || record.executionMode === "comprehensive" || record.executionMode === "hermes")
        ? { executionMode: record.executionMode }
        : {}),
    };
  }

  if (type === "design_experiment" && designSummary && executionPrompt) {
    return {
      type,
      designSummary,
      executionPrompt,
      ...(typeof record.rationale === "string" ? { rationale: record.rationale } : {}),
    };
  }

  if (answer) {
    return {
      type: "direct_response",
      answer,
      ...(workflowHint ? { workflowHint } : {}),
      ...(record.experimentProposal && typeof record.experimentProposal === "object" ? { experimentProposal: record.experimentProposal } : {}),
    };
  }

  if (fullQuery) {
    return {
      type: "search",
      fullQuery,
      ...(typeof record.rationale === "string" ? { rationale: record.rationale } : {}),
    };
  }

  return record;
}

function shouldUseToolChain(message: string): boolean {
  return /\b(book|books|novel|novels|story|stories|fiction|passage|passages|quote|quotes|theme|themes|motif|motifs|corpus|search|find|show me|look up|examples?|compare|contrast|which works?|which book|who writes|where does)\b/i.test(message);
}

function shouldDesignExperiment(message: string): boolean {
  return /\b(experiment|label(?:ing)?|annotat(?:e|ion)|taxonomy|schema|aggregate|aggregation|paper|chart|dataset|subset|run (?:an )?experiment)\b/i.test(message);
}

function looksLikeApproval(message: string): boolean {
  return /\b(yes|yep|yeah|looks good|sounds good|approved|approve|go ahead|run it|do it|ship it|that works|let's do it|lets do it)\b/i.test(message);
}

function fallbackDirectAnswer(message: string): string {
  if (/\bwhat kind of things should i look up\b/i.test(message)) {
    return "You could ask for themes, moods, character types, exact passages, comparisons between books, or examples of a feeling like grief, obsession, or reconciliation across the corpus.";
  }
  if (shouldDesignExperiment(message)) {
    return "Before I run an experiment, I need the design to be concrete. Tell me the corpus scope, what should be labeled or extracted, how those labels should be aggregated, and what the final output should look like.";
  }
  if (/\bcan you help\b/i.test(message) || /\bwhat can you do\b/i.test(message)) {
    return "I can help you search the corpus for books, themes, character patterns, comparisons, and specific passages, or I can help you design a corpus experiment before running it.";
  }
  return "I can respond directly when you are brainstorming or designing a study, and I can launch either a search run or an approved experiment when you are ready.";
}

function buildFallbackExperimentProposal(message: string) {
  const normalized = message.trim() || "the proposed experiment";
  return {
    title: "Experiment Proposal",
    summary: [
      "Before I run this experiment, I want explicit approval.",
      `Current request: ${normalized}`,
      "I still need a concrete scope, labeling or extraction schema, aggregation plan, and target output before the runner starts.",
    ].join("\n\n"),
    approvalPrompt: `I approve this experiment plan. Build the scripts, run the labeling and aggregation workflow, and produce the paper draft and charts.\n\nExperiment request:\n${normalized}`,
  };
}

export class FallbackRouter implements Router {
  async decide(context: RouterContext): Promise<RouterDecision> {
    if (context.requestedWorkflow === "search") {
      return {
        type: "search",
        fullQuery: context.userMessage.trim(),
        executionMode: "semantic",
      };
    }
    if (context.requestedWorkflow === "design_experiment" || shouldDesignExperiment(context.userMessage)) {
      const priorAssistant = [...context.conversationHistory].reverse().find((entry) => entry.role === "assistant")?.content ?? "";
      if (looksLikeApproval(context.userMessage) && /\bexperiment|label|aggregate|paper|chart\b/i.test(priorAssistant)) {
        return {
          type: "design_experiment",
          designSummary: priorAssistant.trim().slice(0, 800) || "Approved experiment design.",
          executionPrompt: `Design and run the approved experiment over the AlphaBook corpus.\n\nLatest approval message: ${context.userMessage.trim()}\n\nApproved design:\n${priorAssistant.trim()}`,
          rationale: "The experiment design appears approved, so the runner can start building and executing it.",
        };
      }
      return {
        type: "direct_response",
        answer: fallbackDirectAnswer(context.userMessage),
        workflowHint: "design_experiment",
        experimentProposal: buildFallbackExperimentProposal(context.userMessage),
      };
    }
    if (shouldUseToolChain(context.userMessage)) {
      return {
        type: "search",
        fullQuery: context.userMessage.trim(),
        executionMode: "semantic",
      };
    }
    return {
      type: "direct_response",
      answer: fallbackDirectAnswer(context.userMessage),
    };
  }
}

export class ScriptedRouter implements Router {
  private cursor = 0;

  constructor(private readonly script: Array<RouterDecision | LegacyToolChainDecision>) {}

  async decide(): Promise<RouterDecision> {
    const next = this.script[this.cursor];
    this.cursor += 1;
    if (!next) {
      throw new Error("Scripted router exhausted.");
    }
    if (next.type === "tool_chain") {
      return {
        type: "search",
        fullQuery: next.fullQuery,
      };
    }
    return next;
  }
}

export class OpenAIRouter implements Router {
  constructor(
    private readonly apiKey: string,
    private readonly model: string,
    private readonly fetchImpl: typeof fetch = (input, init) => fetch(input, init),
    private readonly billing?: BillingService,
    private readonly systemPrompt: string = ROUTER_SYSTEM_PROMPT,
  ) {}

  async decide(context: RouterContext): Promise<RouterDecision> {
    const body = {
      model: this.model,
      response_format: { type: "json_object" as const },
      messages: [
        {
          role: "system",
          content: `${this.systemPrompt}\nReturn a single JSON object matching the requested output shape.`,
        },
        {
          role: "user",
          content: JSON.stringify({
            task: "Route the user's message before any search or experiment tools run.",
            responseInstructions: "Reply with JSON only.",
            userMessage: context.userMessage,
            requestedWorkflow: context.requestedWorkflow ?? "auto",
            conversationHistory: context.conversationHistory,
            outputShape: {
              type: "direct_response | search | design_experiment",
              answer: "string when using direct_response",
              workflowHint: "optional search | design_experiment hint when using direct_response",
              experimentProposal: "{ title, summary, approvalPrompt } when proposing an experiment for approval",
              fullQuery: "string when using search",
              rationale: "optional short explanation when using search or design_experiment",
              executionMode: "optional semantic | comprehensive | hermes when using search",
              designSummary: "string when using design_experiment",
              executionPrompt: "string when using design_experiment",
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
        throw new Error("Router timed out before choosing how to handle this request.");
      }
      throw error;
    }
    if (!response.ok) {
      const text = await response.text();
      throw new Error(`Router request failed: ${text}`);
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
            phase: "router",
          },
        });
      }
    }
    const content = payload.choices?.[0]?.message?.content;
    if (!content) {
      throw new Error("Router response was empty.");
    }
    const parsed = coerceRouterDecision(parseModelJsonObject<unknown>(content));
    const result = RouterDecisionSchema.safeParse(parsed);
    if (result.success) {
      return result.data;
    }
    const fallbackRouter = new FallbackRouter();
    return fallbackRouter.decide(context);
  }
}
