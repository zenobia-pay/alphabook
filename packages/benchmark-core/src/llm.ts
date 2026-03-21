import type { BenchmarkPassage, BenchmarkQuery } from "./types";

export interface JudgedPassageScore {
  passageId: string;
  score: number;
  rationale?: string;
}

export interface PassageJudgeInput {
  query: BenchmarkQuery;
  passages: BenchmarkPassage[];
}

export interface PassageJudge {
  id: string;
  judgeBatch(input: PassageJudgeInput): Promise<JudgedPassageScore[]>;
}

export interface OpenAICompatibleJudgeInput {
  apiKey: string;
  model: string;
  id?: string;
  baseUrl?: string;
  fetchImpl?: typeof fetch;
  includeRationale?: boolean;
  extraHeaders?: Record<string, string>;
}

function clampScore(score: number): number {
  if (!Number.isFinite(score)) {
    return 0;
  }
  return Math.max(0, Math.min(1, score));
}

function extractJsonObject(raw: string): string {
  const trimmed = raw.trim();
  if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
    return trimmed;
  }

  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)\s*```/iu);
  if (fenced?.[1]) {
    return fenced[1].trim();
  }

  const firstBrace = trimmed.indexOf("{");
  const lastBrace = trimmed.lastIndexOf("}");
  if (firstBrace >= 0 && lastBrace > firstBrace) {
    return trimmed.slice(firstBrace, lastBrace + 1);
  }

  return trimmed;
}

export function normalizeJudgedScores(
  passages: BenchmarkPassage[],
  rawScores: JudgedPassageScore[],
): JudgedPassageScore[] {
  const passageIds = new Set(passages.map((passage) => passage.id));
  const normalized = rawScores
    .filter((entry) => passageIds.has(entry.passageId))
    .map((entry) => ({
      ...entry,
      score: clampScore(entry.score),
    }));

  const seen = new Set(normalized.map((entry) => entry.passageId));
  for (const passage of passages) {
    if (!seen.has(passage.id)) {
      normalized.push({
        passageId: passage.id,
        score: 0,
      });
    }
  }
  return normalized;
}

export function createOpenAIExhaustiveJudge(input: {
  apiKey: string;
  model?: string;
  fetchImpl?: typeof fetch;
  includeRationale?: boolean;
}): PassageJudge {
  const { apiKey, model = "gpt-5.2", fetchImpl = fetch, includeRationale = true } = input;

  return createOpenAICompatibleExhaustiveJudge({
    apiKey,
    model,
    id: `openai-${model}`,
    baseUrl: "https://api.openai.com/v1/chat/completions",
    fetchImpl,
    includeRationale,
  });
}

export function createOpenAICompatibleExhaustiveJudge(input: OpenAICompatibleJudgeInput): PassageJudge {
  const {
    apiKey,
    model,
    id = model,
    baseUrl = "https://api.openai.com/v1/chat/completions",
    fetchImpl = fetch,
    includeRationale = true,
    extraHeaders,
  } = input;

  return {
    id,
    async judgeBatch({ query, passages }) {
      const prompt = [
        "You are grading passage relevance for a retrieval benchmark.",
        "Return strict JSON with a top-level key named scores.",
        includeRationale
          ? "Each score item must contain: passageId, score, rationale."
          : "Each score item must contain: passageId and score.",
        "Score on a 0 to 1 scale.",
        "A score of 1 means the passage materially helps answer the query.",
        "A score of 0 means irrelevant.",
        "Do not omit any passage ids.",
        "",
        `Query: ${query.text}`,
        `Query family: ${query.family}`,
        query.filters ? `Filters: ${JSON.stringify(query.filters)}` : "Filters: {}",
        "",
        "Passages:",
        ...passages.map((passage, index) => [
          `Passage ${index + 1}:`,
          `passageId: ${passage.id}`,
          `documentId: ${passage.documentId}`,
          `metadata: ${JSON.stringify(passage.metadata ?? {})}`,
          passage.text,
        ].join("\n")),
      ].join("\n");

      const response = await fetchImpl(baseUrl, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${apiKey}`,
          ...extraHeaders,
        },
        body: JSON.stringify({
          model,
          response_format: {
            type: "json_schema",
            json_schema: {
              name: "passage_scores",
              schema: {
                type: "object",
                additionalProperties: false,
                required: ["scores"],
                properties: {
                  scores: {
                    type: "array",
                    items: {
                      type: "object",
                      additionalProperties: false,
                      required: includeRationale ? ["passageId", "score", "rationale"] : ["passageId", "score"],
                      properties: {
                        passageId: { type: "string" },
                        score: { type: "number" },
                        ...(includeRationale ? { rationale: { type: "string" } } : {}),
                      },
                    },
                  },
                },
              },
            },
          },
          messages: [
            {
              role: "system",
              content: "Score retrieval passages and return only valid JSON.",
            },
            {
              role: "user",
              content: prompt,
            },
          ],
        }),
      });

      if (!response.ok) {
        throw new Error(`OpenAI exhaustive judge failed with status ${response.status}`);
      }

      const payload = await response.json() as {
        choices?: Array<{
          message?: {
            content?: string | null;
          };
        }>;
      };

      const content = payload.choices?.[0]?.message?.content;
      if (!content) {
        throw new Error("OpenAI exhaustive judge returned no content.");
      }

      const parsed = JSON.parse(extractJsonObject(content)) as {
        scores?: Array<JudgedPassageScore>;
      };

      return normalizeJudgedScores(passages, parsed.scores ?? []);
    },
  };
}
