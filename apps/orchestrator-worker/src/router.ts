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
    executionMode: z.enum(["semantic", "comprehensive", "agentic"]).optional(),
  }),
  z.object({
    type: z.literal("design_experiment"),
    designSummary: z.string().min(1),
    executionPrompt: z.string().min(1),
    rationale: z.string().min(1).optional(),
  }),
]);

export type RouterDecision = z.infer<typeof RouterDecisionSchema>;
type SearchExecutionMode = "semantic" | "comprehensive" | "agentic";
type RouterAuditLog = (event: string, payload: Record<string, unknown>) => void;
const SearchExecutionModeSchema = z.enum(["semantic", "comprehensive", "agentic"]);

function inferExplicitExecutionMode(userMessage: string): SearchExecutionMode | undefined {
  const normalized = userMessage.toLowerCase();
  if (/\bagentic\b/.test(normalized)) {
    return "agentic";
  }
  if (
    /\b(comprehensive|deep research|deeper research|sprite fanout|sprite_fanout)\b/.test(normalized)
  ) {
    return "comprehensive";
  }
  if (/\bsemantic\b/.test(normalized)) {
    return "semantic";
  }
  return undefined;
}

export interface RouterContext {
  userMessage: string;
  requestedWorkflow?: "auto" | "search" | "design_experiment";
  conversationHistory: Array<{
    role: "user" | "assistant" | "system" | "tool";
    content: string;
  }>;
  billingContext?: BillingContext;
  auditLog?: RouterAuditLog;
}

export interface Router {
  decide(context: RouterContext): Promise<RouterDecision>;
}

export class ScriptedRouter implements Router {
  private cursor = 0;

  constructor(private readonly script: RouterDecision[]) {}

  async decide(): Promise<RouterDecision> {
    const next = this.script[this.cursor];
    this.cursor += 1;
    if (!next) {
      throw new Error("Scripted router exhausted.");
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

  private coerceDecision(parsed: unknown, context: RouterContext): {
    decision: RouterDecision;
    fallbackKind: "sanitized" | "defaulted";
    reason: string;
  } | null {
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return null;
    }
    const candidate = parsed as Record<string, unknown>;
    const rawType = typeof candidate.type === "string" ? candidate.type : null;
    const userMessage = context.userMessage.trim();
    const answer = typeof candidate.answer === "string" && candidate.answer.trim().length > 0
      ? candidate.answer.trim()
      : null;
    const fullQuery = typeof candidate.fullQuery === "string" && candidate.fullQuery.trim().length > 0
      ? candidate.fullQuery.trim()
      : null;
    const designSummary = typeof candidate.designSummary === "string" && candidate.designSummary.trim().length > 0
      ? candidate.designSummary.trim()
      : null;
    const executionPrompt = typeof candidate.executionPrompt === "string" && candidate.executionPrompt.trim().length > 0
      ? candidate.executionPrompt.trim()
      : null;
    const rationale = typeof candidate.rationale === "string" && candidate.rationale.trim().length > 0
      ? candidate.rationale.trim()
      : undefined;
    const explicitExecutionMode = inferExplicitExecutionMode(context.userMessage);
    const workflowHint = candidate.workflowHint === "search" || candidate.workflowHint === "design_experiment"
      ? candidate.workflowHint
      : undefined;
    const rawExecutionMode = SearchExecutionModeSchema.safeParse(candidate.executionMode).success
      ? candidate.executionMode as SearchExecutionMode
      : undefined;
    const executionMode = rawExecutionMode;
    const experimentProposalCandidate = candidate.experimentProposal
      && typeof candidate.experimentProposal === "object"
      && !Array.isArray(candidate.experimentProposal)
      ? candidate.experimentProposal as Record<string, unknown>
      : null;
    const experimentProposal = experimentProposalCandidate
      && typeof experimentProposalCandidate.title === "string"
      && experimentProposalCandidate.title.trim().length > 0
      && typeof experimentProposalCandidate.summary === "string"
      && experimentProposalCandidate.summary.trim().length > 0
      && typeof experimentProposalCandidate.approvalPrompt === "string"
      && experimentProposalCandidate.approvalPrompt.trim().length > 0
      ? {
          title: experimentProposalCandidate.title.trim(),
          summary: experimentProposalCandidate.summary.trim(),
          approvalPrompt: experimentProposalCandidate.approvalPrompt.trim(),
        }
      : undefined;

    if (rawType === "direct_response" && answer) {
      return {
        decision: {
          type: "direct_response",
          answer,
          ...(workflowHint ? { workflowHint } : {}),
          ...(experimentProposal ? { experimentProposal } : {}),
        },
        fallbackKind: "sanitized",
        reason: "Router returned direct_response with extra or malformed optional fields.",
      };
    }

    if (rawType === "search") {
      const coercedExecutionMode = explicitExecutionMode ?? executionMode ?? "agentic";
      return {
        decision: {
          type: "search",
          fullQuery: fullQuery ?? userMessage,
          ...(rationale ? { rationale } : {}),
          executionMode: coercedExecutionMode,
        },
        fallbackKind: explicitExecutionMode || executionMode ? "sanitized" : "defaulted",
        reason: explicitExecutionMode
          ? `Router returned search, but the user explicitly requested ${explicitExecutionMode} mode so the decision was corrected.`
          : executionMode
          ? "Router returned search with recoverable schema drift."
          : "Router returned search with an invalid or missing executionMode; defaulted to agentic.",
      };
    }

    if (rawType === "design_experiment" && designSummary && executionPrompt) {
      return {
        decision: {
          type: "design_experiment",
          designSummary,
          executionPrompt,
          ...(rationale ? { rationale } : {}),
        },
        fallbackKind: "sanitized",
        reason: "Router returned design_experiment with recoverable schema drift.",
      };
    }

    if (fullQuery) {
      const coercedExecutionMode = explicitExecutionMode ?? executionMode ?? "agentic";
      return {
        decision: {
          type: "search",
          fullQuery,
          executionMode: coercedExecutionMode,
          rationale: "Router response was malformed, but it included a search query so the request can continue safely.",
        },
        fallbackKind: "defaulted",
        reason: "Router response was malformed but included a usable fullQuery.",
      };
    }

    if (answer) {
      return {
        decision: {
          type: "direct_response",
          answer,
          ...(workflowHint ? { workflowHint } : {}),
        },
        fallbackKind: "defaulted",
        reason: "Router response was malformed but included a usable direct response.",
      };
    }

    if (context.requestedWorkflow === "search" && userMessage.length > 0) {
      return {
        decision: {
          type: "search",
          fullQuery: userMessage,
          executionMode: explicitExecutionMode ?? "agentic",
          rationale: explicitExecutionMode
            ? `Router response was malformed, so the request fell back to the user's explicit ${explicitExecutionMode} mode.`
            : "Router response was malformed, so the request fell back to an agentic search using the user message.",
        },
        fallbackKind: "defaulted",
        reason: "Router response was unusable and the caller explicitly requested search.",
      };
    }

    return {
      decision: {
        type: "direct_response",
        answer: "I hit a routing glitch, but I can still help. Tell me what you want to search for in the corpus and I’ll run it.",
      },
      fallbackKind: "defaulted",
      reason: "Router response was unusable and there was no safe search payload to continue with.",
    };
  }

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
            outputContract: {
              allowedTypes: ["direct_response", "search", "design_experiment"],
              rules: [
                "Return exactly one object.",
                "Set type to one of the allowedTypes values.",
                "Only include fields that belong to the chosen type.",
                "For direct_response, include answer. Include workflowHint only when it is exactly search or design_experiment.",
                "For direct_response experiment proposals, include experimentProposal with title, summary, and approvalPrompt.",
                "For search, include fullQuery and optionally rationale or executionMode.",
                "For design_experiment, include designSummary and executionPrompt and optionally rationale.",
              ],
              examples: [
                {
                  type: "direct_response",
                  answer: "I can search the AlphaBook corpus for grief in fiction, memoir, or specific books if you want to study how the dataset handles that topic.",
                },
                {
                  type: "search",
                  fullQuery: "Find novels in the corpus that portray grief through obsession or spiritual crisis.",
                  executionMode: "agentic",
                },
                {
                  type: "design_experiment",
                  designSummary: "Label a selected corpus slice for grief framing, then aggregate the labels into charts for a paper draft.",
                  executionPrompt: "Create and run the approved labeling and aggregation workflow over the selected corpus slice, then produce the paper draft and charts.",
                },
              ],
            },
          }),
        },
      ],
    };
    context.auditLog?.("router.openai.request", {
      model: this.model,
      request: body,
    });
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
      context.auditLog?.("router.openai.response", {
        ok: false,
        status: response.status,
        statusText: response.statusText,
        body: text,
      });
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
    context.auditLog?.("router.openai.response", {
      ok: true,
      status: response.status,
      statusText: response.statusText,
      body: payload,
    });
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
    const parsed = parseModelJsonObject<unknown>(content);
    const validated = RouterDecisionSchema.safeParse(parsed);
    if (validated.success) {
      const explicitExecutionMode = inferExplicitExecutionMode(context.userMessage);
      if (validated.data.type === "search" && explicitExecutionMode && validated.data.executionMode !== explicitExecutionMode) {
        const correctedDecision: RouterDecision = {
          ...validated.data,
          executionMode: explicitExecutionMode,
        };
        context.auditLog?.("router.output.override", {
          reason: "User explicitly requested an execution mode that overrode the router response.",
          requestedExecutionMode: explicitExecutionMode,
          routerExecutionMode: validated.data.executionMode ?? null,
          decision: correctedDecision,
        });
        return correctedDecision;
      }
      return validated.data;
    }
    const fallback = this.coerceDecision(parsed, context);
    if (fallback) {
      context.auditLog?.("router.output.fallback", {
        fallbackKind: fallback.fallbackKind,
        reason: fallback.reason,
        parsed,
        validationError: validated.error.message,
        decision: fallback.decision,
      });
      return fallback.decision;
    }
    throw validated.error;
  }
}
