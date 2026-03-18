import { z } from "zod";

import { HARD_LIMITS } from "@alphabook/corpus-core";
import { ROUTER_SYSTEM_PROMPT } from "@alphabook/shared";

import { openAIUsageFromResponse, type BillingContext, type BillingService } from "./billing";
import { parseModelJsonObject } from "./json";

const RouterDecisionSchema = z.union([
  z.object({
    type: z.literal("direct_response"),
    answer: z.string().min(1),
  }),
  z.object({
    type: z.literal("tool_chain"),
    fullQuery: z.string().min(1),
  }),
]);

export type RouterDecision = z.infer<typeof RouterDecisionSchema>;

export interface RouterContext {
  userMessage: string;
  conversationHistory: Array<{
    role: "user" | "assistant" | "system" | "tool";
    content: string;
  }>;
  billingContext?: BillingContext;
}

export interface Router {
  decide(context: RouterContext): Promise<RouterDecision>;
}

function shouldUseToolChain(message: string): boolean {
  return /\b(book|books|novel|novels|story|stories|fiction|passage|passages|quote|quotes|theme|themes|motif|motifs|corpus|search|find|show me|look up|examples?|compare|contrast|which works?|which book|who writes|where does)\b/i.test(message);
}

function fallbackDirectAnswer(message: string): string {
  if (/\bwhat kind of things should i look up\b/i.test(message)) {
    return "You could ask for themes, moods, character types, exact passages, comparisons between books, or examples of a feeling like grief, obsession, or reconciliation across the corpus.";
  }
  if (/\bcan you help\b/i.test(message) || /\bwhat can you do\b/i.test(message)) {
    return "I can help you search the corpus for books, themes, character patterns, comparisons, and specific passages, or I can help you refine a search before running it.";
  }
  return "I can respond directly when you are brainstorming or asking how to search, and I can run the book-search pipeline when you want evidence from the corpus.";
}

export class FallbackRouter implements Router {
  async decide(context: RouterContext): Promise<RouterDecision> {
    if (shouldUseToolChain(context.userMessage)) {
      return {
        type: "tool_chain",
        fullQuery: context.userMessage.trim(),
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
  ) {}

  async decide(context: RouterContext): Promise<RouterDecision> {
    const body = {
      model: this.model,
      response_format: { type: "json_object" as const },
      messages: [
        {
          role: "system",
          content: `${ROUTER_SYSTEM_PROMPT}\nReturn a single JSON object matching the requested output shape.`,
        },
        {
          role: "user",
          content: JSON.stringify({
            task: "Route the user's message before any search tools run.",
            responseInstructions: "Reply with JSON only.",
            userMessage: context.userMessage,
            conversationHistory: context.conversationHistory,
            outputShape: {
              type: "direct_response | tool_chain",
              answer: "string when using direct_response",
              fullQuery: "string when using tool_chain",
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
    return RouterDecisionSchema.parse(parseModelJsonObject<unknown>(content));
  }
}
