import type { AppStore } from "./store";

export interface BillingContext {
  userId: string;
  sessionId?: string | null;
  runId?: string | null;
  source: string;
}

export interface BillingUsageEventInput {
  provider: string;
  model: string;
  operation: string;
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
  cachedInputTokens?: number;
  requestId?: string | null;
  requestJson?: Record<string, unknown> | null;
  responseJson?: Record<string, unknown> | null;
  metadata?: Record<string, unknown>;
  createdAt?: string;
}

export interface BillingCheckResult {
  allowed: boolean;
  limitUsd: number;
  spendUsd: number;
  windowStartedAt: string;
}

export interface BillingService {
  check(userId: string, now?: number): Promise<BillingCheckResult>;
  track(context: BillingContext, event: BillingUsageEventInput): Promise<void>;
}

interface BillingConfig {
  monthlyLimitUsd?: number;
  modelPricing?: Record<string, ModelPricing>;
}

interface ModelPricing {
  inputPerMillionUsd: number;
  outputPerMillionUsd: number;
  cachedInputPerMillionUsd?: number;
}

const THIRTY_DAYS_MS = 30 * 24 * 60 * 60 * 1000;

const DEFAULT_MODEL_PRICING: Record<string, ModelPricing> = {
  "gpt-5": {
    inputPerMillionUsd: 1.25,
    cachedInputPerMillionUsd: 0.125,
    outputPerMillionUsd: 10,
  },
  "gpt-5.2": {
    inputPerMillionUsd: 1.25,
    cachedInputPerMillionUsd: 0.125,
    outputPerMillionUsd: 10,
  },
  "text-embedding-3-small": {
    inputPerMillionUsd: 0.02,
    cachedInputPerMillionUsd: 0.02,
    outputPerMillionUsd: 0,
  },
};

function roundUsd(value: number): number {
  return Math.round(value * 1_000_000) / 1_000_000;
}

function resolvePricing(model: string, pricing: Record<string, ModelPricing>): ModelPricing | null {
  if (pricing[model]) {
    return pricing[model];
  }
  for (const [candidate, resolved] of Object.entries(pricing)) {
    if (model.startsWith(`${candidate}-`)) {
      return resolved;
    }
  }
  if (model.startsWith("gpt-5")) {
    return pricing["gpt-5"] ?? null;
  }
  return null;
}

function computeCostUsd(
  event: Required<Pick<BillingUsageEventInput, "inputTokens" | "outputTokens" | "cachedInputTokens">> & Pick<BillingUsageEventInput, "model">,
  pricing: ModelPricing | null,
): number {
  if (!pricing) {
    return 0;
  }
  const cachedInputTokens = Math.max(0, event.cachedInputTokens);
  const inputTokens = Math.max(0, event.inputTokens);
  const outputTokens = Math.max(0, event.outputTokens);
  const uncachedInputTokens = Math.max(0, inputTokens - cachedInputTokens);
  return roundUsd(
    (uncachedInputTokens / 1_000_000) * pricing.inputPerMillionUsd
      + (cachedInputTokens / 1_000_000) * (pricing.cachedInputPerMillionUsd ?? pricing.inputPerMillionUsd)
      + (outputTokens / 1_000_000) * pricing.outputPerMillionUsd,
  );
}

export function createBillingService(store: AppStore, config: BillingConfig = {}): BillingService {
  const monthlyLimitUsd = config.monthlyLimitUsd ?? 50;
  const pricing = {
    ...DEFAULT_MODEL_PRICING,
    ...(config.modelPricing ?? {}),
  };

  return {
    async check(userId: string, now = Date.now()): Promise<BillingCheckResult> {
      const windowStartedAt = new Date(now - THIRTY_DAYS_MS).toISOString();
      const spend = await store.getBillingSpend(userId, windowStartedAt);
      return {
        allowed: spend.totalCostUsd <= monthlyLimitUsd,
        limitUsd: monthlyLimitUsd,
        spendUsd: spend.totalCostUsd,
        windowStartedAt,
      };
    },

    async track(context: BillingContext, event: BillingUsageEventInput): Promise<void> {
      const inputTokens = Math.max(0, Math.trunc(event.inputTokens ?? 0));
      const outputTokens = Math.max(0, Math.trunc(event.outputTokens ?? 0));
      const cachedInputTokens = Math.max(0, Math.trunc(event.cachedInputTokens ?? 0));
      const totalTokens = Math.max(0, Math.trunc(event.totalTokens ?? inputTokens + outputTokens));
      const costUsd = computeCostUsd(
        {
          model: event.model,
          inputTokens,
          outputTokens,
          cachedInputTokens,
        },
        resolvePricing(event.model, pricing),
      );

      await store.createBillingEvent({
        userId: context.userId,
        sessionId: context.sessionId ?? null,
        runId: context.runId ?? null,
        source: context.source,
        provider: event.provider,
        model: event.model,
        operation: event.operation,
        inputTokens,
        outputTokens,
        totalTokens,
        cachedInputTokens,
        costUsd,
        requestId: event.requestId ?? null,
        requestJson: event.requestJson ?? null,
        responseJson: event.responseJson ?? null,
        metadata: event.metadata ?? {},
        createdAt: event.createdAt,
      });
    },
  };
}

export function openAIUsageFromResponse(payload: Record<string, unknown>) {
  const usage = payload.usage && typeof payload.usage === "object"
    ? payload.usage as Record<string, unknown>
    : null;
  if (!usage) {
    return null;
  }

  const promptTokens = Number(usage.prompt_tokens ?? usage.input_tokens ?? 0);
  const completionTokens = Number(usage.completion_tokens ?? usage.output_tokens ?? 0);
  const totalTokens = Number(usage.total_tokens ?? promptTokens + completionTokens);
  const promptDetails = usage.prompt_tokens_details && typeof usage.prompt_tokens_details === "object"
    ? usage.prompt_tokens_details as Record<string, unknown>
    : null;
  const cachedInputTokens = Number(promptDetails?.cached_tokens ?? 0);

  return {
    inputTokens: Number.isFinite(promptTokens) ? promptTokens : 0,
    outputTokens: Number.isFinite(completionTokens) ? completionTokens : 0,
    totalTokens: Number.isFinite(totalTokens) ? totalTokens : 0,
    cachedInputTokens: Number.isFinite(cachedInputTokens) ? cachedInputTokens : 0,
  };
}
