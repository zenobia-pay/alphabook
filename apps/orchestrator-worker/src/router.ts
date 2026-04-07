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
                  answer: "Tell me which kind of grief examples you want and I can narrow the corpus search.",
                },
                {
                  type: "search",
                  fullQuery: "Find novels in the corpus that portray grief through obsession or spiritual crisis.",
                  executionMode: "semantic",
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
    const parsed = parseModelJsonObject<unknown>(content);
    return RouterDecisionSchema.parse(parsed);
  }
}
