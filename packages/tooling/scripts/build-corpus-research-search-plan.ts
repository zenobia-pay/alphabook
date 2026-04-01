import { readFile, writeFile } from "node:fs/promises";
import * as path from "node:path";

import { loadDotEnvFile } from "./lib/benchmark-env";

interface ScriptOptions {
  query: string;
  output?: string;
  model: string;
}

interface SearchPlan {
  query: string;
  focusSummary: string;
  searchRegex: string;
  searchTerms: string[];
  exclusionTerms: string[];
  rationale: string;
}

function parseArgs(argv: string[]): ScriptOptions {
  const options: ScriptOptions = {
    query: "",
    model: "gpt-5-nano",
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    switch (arg) {
      case "--query":
        options.query = argv[++index] ?? options.query;
        break;
      case "--output":
        options.output = argv[++index] ?? options.output;
        break;
      case "--model":
        options.model = argv[++index] ?? options.model;
        break;
      case "--help":
      case "-h":
        process.stdout.write("Usage: node --import tsx packages/tooling/scripts/build-corpus-research-search-plan.ts --query <text> [--output /path/to/search-plan.json]\n");
        process.exit(0);
        break;
      default:
        throw new Error(`Unknown argument: ${arg}`);
    }
  }
  if (!options.query) {
    throw new Error("--query is required.");
  }
  return options;
}

function extractJsonObject(raw: string): string {
  const trimmed = raw.trim();
  if (trimmed.startsWith("{")) {
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

function schema() {
  return {
    name: "corpus_research_search_plan",
    schema: {
      type: "object",
      additionalProperties: false,
      required: ["focusSummary", "searchRegex", "searchTerms", "exclusionTerms", "rationale"],
      properties: {
        focusSummary: { type: "string" },
        searchRegex: { type: "string" },
        searchTerms: {
          type: "array",
          items: { type: "string" },
        },
        exclusionTerms: {
          type: "array",
          items: { type: "string" },
        },
        rationale: { type: "string" },
      },
    },
  };
}

async function callOpenAI(apiKey: string, model: string, query: string): Promise<SearchPlan> {
  const response = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model,
      response_format: {
        type: "json_schema",
        json_schema: schema(),
      },
      messages: [
        {
          role: "system",
          content: [
            "You design high-recall ripgrep retrieval plans for corpus research.",
            "Given a user research query, produce a regex that can be used with ripgrep against raw text files.",
            "The regex should favor recall, be reasonably compact, and only include search concepts implied by the user query.",
            "Do not hardcode any domain from previous runs.",
            "searchRegex must be a bare regex body suitable for wrapping in bash single quotes.",
            "Escape backslashes as needed for JSON, but do not include regex delimiters.",
          ].join(" "),
        },
        {
          role: "user",
          content: `User query: ${query}`,
        },
      ],
    }),
  });

  if (!response.ok) {
    throw new Error(`OpenAI request failed with status ${response.status}: ${(await response.text()).slice(0, 400)}`);
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
    throw new Error("OpenAI request returned no content.");
  }
  const parsed = JSON.parse(extractJsonObject(content)) as Omit<SearchPlan, "query">;
  return {
    query,
    focusSummary: parsed.focusSummary,
    searchRegex: parsed.searchRegex,
    searchTerms: parsed.searchTerms,
    exclusionTerms: parsed.exclusionTerms,
    rationale: parsed.rationale,
  };
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  await loadDotEnvFile().catch(() => undefined);
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    throw new Error("OPENAI_API_KEY is required.");
  }

  const plan = await callOpenAI(apiKey, options.model, options.query);
  const serialized = `${JSON.stringify(plan, null, 2)}\n`;
  if (options.output) {
    const target = path.resolve(process.cwd(), options.output);
    await writeFile(target, serialized);
  } else {
    process.stdout.write(serialized);
  }
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
