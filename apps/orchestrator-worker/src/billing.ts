import type { AppStore } from "./store";

export interface BillingContext {
  userId: string;
  sessionId?: string | null;
  runId?: string | null;
  source: string;
}

export interface BillingUsageEventInput {
  eventId?: string;
  provider: string;
  model: string;
  operation: string;
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
  cachedInputTokens?: number;
  costUsd?: number;
  requestId?: string | null;
  requestJson?: Record<string, unknown> | null;
  responseJson?: Record<string, unknown> | null;
  metadata?: Record<string, unknown>;
  createdAt?: string;
}

export interface BillingCheckResult {
  allowed: boolean;
  tier: "free" | "studio";
  subscriptionStatus: "free" | "incomplete" | "incomplete_expired" | "trialing" | "active" | "past_due" | "canceled" | "unpaid" | "paused";
  limitCredits: number;
  usedCredits: number;
  remainingCredits: number;
  spendUsd: number;
  windowStartedAt: string;
  windowEndsAt: string;
  checkoutEligible: boolean;
}

export interface BillingService {
  check(userId: string, now?: number): Promise<BillingCheckResult>;
  getOverview(userId: string, now?: number): Promise<BillingCheckResult>;
  track(context: BillingContext, event: BillingUsageEventInput): Promise<void>;
}

interface BillingConfig {
  freeMonthlyCredits?: number;
  studioMonthlyCredits?: number;
  creditsPerUsdCost?: number;
  testMonthlyCredits?: number;
  testUserIds?: string[];
  testUserEmails?: string[];
  modelPricing?: Record<string, ModelPricing>;
}

interface ModelPricing {
  inputPerMillionUsd: number;
  outputPerMillionUsd: number;
  cachedInputPerMillionUsd?: number;
}

const THIRTY_DAYS_MS = 30 * 24 * 60 * 60 * 1000;
const DEFAULT_FREE_MONTHLY_CREDITS = 3_333_330;
const DEFAULT_STUDIO_MONTHLY_CREDITS = 50_000_000;
const DEFAULT_CREDITS_PER_USD_COST = 333_333;
const PAID_ACCESS_STATUSES = new Set(["active", "trialing", "past_due"]);

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

function roundCredits(value: number): number {
  return Math.max(0, Math.ceil(value));
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
  const freeMonthlyCredits = typeof config.freeMonthlyCredits === "number" && Number.isFinite(config.freeMonthlyCredits)
    ? Math.max(0, Math.trunc(config.freeMonthlyCredits))
    : DEFAULT_FREE_MONTHLY_CREDITS;
  const studioMonthlyCredits = typeof config.studioMonthlyCredits === "number" && Number.isFinite(config.studioMonthlyCredits)
    ? Math.max(0, Math.trunc(config.studioMonthlyCredits))
    : DEFAULT_STUDIO_MONTHLY_CREDITS;
  const creditsPerUsdCost = typeof config.creditsPerUsdCost === "number" && Number.isFinite(config.creditsPerUsdCost)
    ? Math.max(1, Math.trunc(config.creditsPerUsdCost))
    : DEFAULT_CREDITS_PER_USD_COST;
  const testMonthlyCredits = typeof config.testMonthlyCredits === "number" && Number.isFinite(config.testMonthlyCredits)
    ? Math.max(0, Math.trunc(config.testMonthlyCredits))
    : null;
  const testUserIds = new Set((config.testUserIds ?? []).map((value) => value.trim()).filter(Boolean));
  const testUserEmails = new Set((config.testUserEmails ?? []).map((value) => value.trim().toLowerCase()).filter(Boolean));
  const pricing = {
    ...DEFAULT_MODEL_PRICING,
    ...(config.modelPricing ?? {}),
  };

  function creditsFromUsd(costUsd: number) {
    return roundCredits(Math.max(0, costUsd) * creditsPerUsdCost);
  }

  async function effectiveMonthlyCredits(userId: string, now: number) {
    const subscription = await store.getSubscriptionByUserId(userId);
    const hasStudioAccess = Boolean(
      subscription
      && PAID_ACCESS_STATUSES.has(subscription.status)
      && (!subscription.currentPeriodEnd || Date.parse(subscription.currentPeriodEnd) >= now),
    );
    let tier: BillingCheckResult["tier"] = hasStudioAccess ? "studio" : "free";
    let subscriptionStatus: BillingCheckResult["subscriptionStatus"] = subscription?.status ?? "free";
    let monthlyCredits = hasStudioAccess ? studioMonthlyCredits : freeMonthlyCredits;
    let checkoutEligible = !hasStudioAccess;

    if (testMonthlyCredits === null) {
      return {
        tier,
        subscriptionStatus,
        monthlyCredits,
        checkoutEligible,
      };
    }
    if (testUserIds.has(userId)) {
      return {
        tier,
        subscriptionStatus,
        monthlyCredits: testMonthlyCredits,
        checkoutEligible,
      };
    }
    if (testUserEmails.size === 0) {
      return {
        tier,
        subscriptionStatus,
        monthlyCredits,
        checkoutEligible,
      };
    }
    const profile = await store.getUserProfile(userId);
    const email = profile?.email?.trim().toLowerCase();
    if (email && testUserEmails.has(email)) {
      monthlyCredits = testMonthlyCredits;
    }
    return {
      tier,
      subscriptionStatus,
      monthlyCredits,
      checkoutEligible,
    };
  }

  async function overview(userId: string, now: number): Promise<BillingCheckResult> {
    const windowStartedAt = new Date(now - THIRTY_DAYS_MS).toISOString();
    const windowEndsAt = new Date(now).toISOString();
    const spend = await store.getBillingSpend(userId, windowStartedAt);
    const usedCredits = creditsFromUsd(spend.totalCostUsd);
    const effective = await effectiveMonthlyCredits(userId, now);
    return {
      allowed: usedCredits <= effective.monthlyCredits,
      tier: effective.tier,
      subscriptionStatus: effective.subscriptionStatus,
      limitCredits: effective.monthlyCredits,
      usedCredits,
      remainingCredits: Math.max(0, effective.monthlyCredits - usedCredits),
      spendUsd: spend.totalCostUsd,
      windowStartedAt,
      windowEndsAt,
      checkoutEligible: effective.checkoutEligible,
    };
  }

  return {
    async check(userId: string, now = Date.now()): Promise<BillingCheckResult> {
      return overview(userId, now);
    },

    async getOverview(userId: string, now = Date.now()): Promise<BillingCheckResult> {
      return overview(userId, now);
    },

    async track(context: BillingContext, event: BillingUsageEventInput): Promise<void> {
      if (typeof context.userId !== "string" || context.userId.trim().length === 0) {
        return;
      }
      const inputTokens = Math.max(0, Math.trunc(event.inputTokens ?? 0));
      const outputTokens = Math.max(0, Math.trunc(event.outputTokens ?? 0));
      const cachedInputTokens = Math.max(0, Math.trunc(event.cachedInputTokens ?? 0));
      const totalTokens = Math.max(0, Math.trunc(event.totalTokens ?? inputTokens + outputTokens));
      const explicitCostUsd = typeof event.costUsd === "number" && Number.isFinite(event.costUsd)
        ? roundUsd(Math.max(0, event.costUsd))
        : null;
      const costUsd = explicitCostUsd ?? computeCostUsd(
        {
          model: event.model,
          inputTokens,
          outputTokens,
          cachedInputTokens,
        },
        resolvePricing(event.model, pricing),
      );

      await store.createBillingEvent({
        id: event.eventId,
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
