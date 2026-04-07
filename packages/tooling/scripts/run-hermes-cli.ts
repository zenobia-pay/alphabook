import process from "node:process";
import { readFile } from "node:fs/promises";
import path from "node:path";

import { loadDotEnvFile } from "./lib/benchmark-env.ts";

type Args = {
  prompt?: string;
  attachJobId?: string;
  apiUrl?: string;
  apiToken?: string;
  model?: string;
  maxTurns?: number;
  pollMs: number;
  logLimit: number;
  previousJobId?: string;
  hermesSessionId?: string;
  corpusRoot?: string;
  cancelOnSigint: boolean;
  includeMetaSources: boolean;
  logMode: "all" | "curated";
};

type JobSummary = {
  id: string;
  state: string;
  running: boolean;
  userPrompt: string | null;
  model: string | null;
  maxTurns: number | null;
  runDir: string;
  innerRunDir: string | null;
  innerRunId: string | null;
  hermesSessionId: string | null;
  launchedAt: string | null;
  startedAt: string | null;
  finishedAt: string | null;
  heartbeatAt: string | null;
  phase: string | null;
  phaseProgressPct: number | null;
  detail: string | null;
  manifestStatus: string | null;
  artifacts: Array<{ name: string }>;
};

type JobResponse = { job: JobSummary };

type LogSource = {
  name: string;
  lines: string[];
};

type LogsResponse = {
  jobId: string;
  mode?: "all" | "curated";
  sources: LogSource[];
  nextCursor: string;
};

type ArtifactResponse = {
  artifact: {
    name: string;
    content: string;
    updatedAt: string | null;
  };
};

type ArtifactSummaryResponse = {
  artifacts: Array<{
    name: string;
    updatedAt: string | null;
  }>;
};

function usage(): never {
  console.error(
    [
      "Usage:",
      "  npm run research:hermes -- --prompt \"Find me examples...\"",
      "",
      "Options:",
      "  --prompt <text>            User prompt to send to Hermes",
      "  --attach-job-id <id>       Inspect an existing Hermes job instead of starting one",
      "  --api-url <url>            Hermes Job API base URL",
      "  --api-token <token>        Hermes Job API bearer token",
      "  --model <model>            Override model, e.g. gpt-5.4",
      "  --max-turns <n>            Override Hermes max turns",
      "  --poll-ms <ms>             Log polling interval (default 3000)",
      "  --log-limit <n>            Max lines per source per poll (default 200)",
      "  --log-mode <all|curated>   Stream every text log/artifact or the smaller curated subset (default all)",
      "  --previous-job-id <id>     Resume a previous Hermes job thread",
      "  --hermes-session-id <id>   Explicit Hermes session id for resume",
      "  --corpus-root <path>       Override corpus root",
      "  --no-cancel-on-sigint      Leave remote job running if you Ctrl-C locally",
      "  --include-meta-sources     Also print heartbeat and wrapper index sources",
      "",
      "Environment:",
      "  HERMES_JOB_API_URL",
      "  HERMES_JOB_API_TOKEN",
      "  HERMES_MODEL",
      "  HERMES_MAX_TURNS",
    ].join("\n"),
  );
  process.exit(1);
}

function parseArgs(argv: string[]): Args {
  const args: Args = {
    pollMs: 3000,
    logLimit: 200,
    cancelOnSigint: true,
    includeMetaSources: false,
    logMode: "all",
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const next = argv[index + 1];
    if ((arg === "--prompt" || arg === "-p") && next) {
      args.prompt = next;
      index += 1;
      continue;
    }
    if (arg === "--attach-job-id" && next) {
      args.attachJobId = next;
      index += 1;
      continue;
    }
    if (arg === "--api-url" && next) {
      args.apiUrl = next;
      index += 1;
      continue;
    }
    if (arg === "--api-token" && next) {
      args.apiToken = next;
      index += 1;
      continue;
    }
    if (arg === "--model" && next) {
      args.model = next;
      index += 1;
      continue;
    }
    if (arg === "--max-turns" && next) {
      args.maxTurns = Number.parseInt(next, 10);
      index += 1;
      continue;
    }
    if (arg === "--poll-ms" && next) {
      args.pollMs = Number.parseInt(next, 10);
      index += 1;
      continue;
    }
    if (arg === "--log-limit" && next) {
      args.logLimit = Number.parseInt(next, 10);
      index += 1;
      continue;
    }
    if (arg === "--log-mode" && next) {
      if (next !== "all" && next !== "curated") {
        throw new Error(`Invalid --log-mode value: ${next}`);
      }
      args.logMode = next;
      index += 1;
      continue;
    }
    if (arg === "--previous-job-id" && next) {
      args.previousJobId = next;
      index += 1;
      continue;
    }
    if (arg === "--hermes-session-id" && next) {
      args.hermesSessionId = next;
      index += 1;
      continue;
    }
    if (arg === "--corpus-root" && next) {
      args.corpusRoot = next;
      index += 1;
      continue;
    }
    if (arg === "--no-cancel-on-sigint") {
      args.cancelOnSigint = false;
      continue;
    }
    if (arg === "--include-meta-sources") {
      args.includeMetaSources = true;
      continue;
    }
    if (!arg.startsWith("-") && !args.prompt) {
      args.prompt = arg;
      continue;
    }
    usage();
  }

  if (!args.prompt && !args.attachJobId) {
    usage();
  }
  if (!Number.isFinite(args.pollMs) || args.pollMs < 250) {
    throw new Error(`Invalid --poll-ms value: ${args.pollMs}`);
  }
  if (!Number.isFinite(args.logLimit) || args.logLimit < 1 || args.logLimit > 500) {
    throw new Error(`Invalid --log-limit value: ${args.logLimit}`);
  }
  if (args.maxTurns != null && (!Number.isFinite(args.maxTurns) || args.maxTurns < 1)) {
    throw new Error(`Invalid --max-turns value: ${args.maxTurns}`);
  }
  return args;
}

async function readWranglerDefaultApiUrl(): Promise<string | null> {
  try {
    const wranglerPath = path.resolve(process.cwd(), "ops/cloudflare/resources.toml");
    const content = await readFile(wranglerPath, "utf8");
    const match = content.match(/^\s*HERMES_JOB_API_URL\s*=\s*"([^"]+)"/m);
    return match?.[1] ?? null;
  } catch {
    return null;
  }
}

async function resolveConfig(args: Args) {
  try {
    await loadDotEnvFile(".dev.vars");
  } catch {
    // Local tooling should still work without .dev.vars.
  }

  const apiUrl = args.apiUrl
    || process.env.HERMES_JOB_API_URL
    || await readWranglerDefaultApiUrl();
  if (!apiUrl) {
    throw new Error("Missing Hermes Job API URL. Pass --api-url or set HERMES_JOB_API_URL.");
  }

  const apiToken = args.apiToken || process.env.HERMES_JOB_API_TOKEN;
  if (!apiToken) {
    throw new Error("Missing Hermes Job API token. Pass --api-token or set HERMES_JOB_API_TOKEN.");
  }

  return {
    apiUrl: apiUrl.replace(/\/+$/u, ""),
    apiToken,
    model: args.model || process.env.HERMES_MODEL || undefined,
    maxTurns: args.maxTurns ?? parseOptionalInt(process.env.HERMES_MAX_TURNS),
  };
}

function parseOptionalInt(value: string | undefined): number | undefined {
  if (!value) {
    return undefined;
  }
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : undefined;
}

async function apiFetch<T>(
  apiUrl: string,
  apiToken: string,
  pathname: string,
  init?: RequestInit,
): Promise<T> {
  const response = await fetch(`${apiUrl}${pathname}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${apiToken}`,
      "content-type": "application/json",
      ...(init?.headers || {}),
    },
  });
  const text = await response.text();
  if (!response.ok) {
    throw new Error(`${response.status} ${response.statusText}: ${text}`);
  }
  return JSON.parse(text) as T;
}

function printHeader(title: string) {
  process.stdout.write(`\n=== ${title} ===\n`);
}

function formatSourceName(name: string): string {
  return name.replaceAll("_", " ");
}

function printLogLines(source: LogSource) {
  for (const line of source.lines) {
    process.stdout.write(`[${formatSourceName(source.name)}] ${line}\n`);
  }
}

function shouldPrintSource(name: string, includeMetaSources: boolean): boolean {
  if (name.startsWith("wrapper/") || name.startsWith("inner/")) {
    return true;
  }
  if (includeMetaSources) {
    return true;
  }
  return !["heartbeat", "wrapper_index"].includes(name);
}

function summarizeJob(job: JobSummary): string {
  const detail = [
    `job=${job.id}`,
    job.model ? `model=${job.model}` : null,
    job.state ? `state=${job.state}` : null,
    job.innerRunId ? `inner_run=${job.innerRunId}` : null,
  ].filter(Boolean);
  return detail.join(" ");
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

async function startOrResumeJob(
  args: Args,
  apiUrl: string,
  apiToken: string,
  defaults: { model?: string; maxTurns?: number },
): Promise<JobSummary> {
  const payload: Record<string, unknown> = {
    userPrompt: args.prompt,
    model: args.model || defaults.model,
    maxTurns: args.maxTurns ?? defaults.maxTurns,
  };
  if (args.corpusRoot) {
    payload.corpusRoot = args.corpusRoot;
  }

  if (args.previousJobId) {
    payload.previousJobId = args.previousJobId;
    if (args.hermesSessionId) {
      payload.hermesSessionId = args.hermesSessionId;
    }
    const result = await apiFetch<JobResponse>(apiUrl, apiToken, "/v1/jobs/resume", {
      method: "POST",
      body: JSON.stringify(payload),
    });
    return result.job;
  }

  const result = await apiFetch<JobResponse>(apiUrl, apiToken, "/v1/jobs", {
    method: "POST",
    body: JSON.stringify(payload),
  });
  return result.job;
}

async function fetchJob(apiUrl: string, apiToken: string, jobId: string): Promise<JobSummary> {
  const result = await apiFetch<JobResponse>(
    apiUrl,
    apiToken,
    `/v1/jobs/${encodeURIComponent(jobId)}`,
  );
  return result.job;
}

async function waitForCompletion(
  jobId: string,
  args: Args,
  apiUrl: string,
  apiToken: string,
): Promise<JobSummary> {
  let cursor: string | undefined;

  while (true) {
    const logs = await apiFetch<LogsResponse>(
      apiUrl,
      apiToken,
      `/v1/jobs/${encodeURIComponent(jobId)}/logs?limit=${args.logLimit}&mode=${encodeURIComponent(args.logMode)}${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`,
    );
    for (const source of logs.sources) {
      if (source.lines.length > 0 && (args.logMode === "all" || shouldPrintSource(source.name, args.includeMetaSources))) {
        printLogLines(source);
      }
    }
    cursor = logs.nextCursor;

    const job = await fetchJob(apiUrl, apiToken, jobId);
    if (!job.running) {
      return job;
    }
    await sleep(args.pollMs);
  }
}

async function fetchBriefing(apiUrl: string, apiToken: string, jobId: string): Promise<string | null> {
  try {
    const artifact = await apiFetch<ArtifactResponse>(
      apiUrl,
      apiToken,
      `/v1/jobs/${encodeURIComponent(jobId)}/artifacts/${encodeURIComponent("briefing.md")}`,
    );
    return artifact.artifact.content;
  } catch {
    return null;
  }
}

async function fetchArtifacts(apiUrl: string, apiToken: string, jobId: string): Promise<ArtifactSummaryResponse["artifacts"]> {
  try {
    const response = await apiFetch<ArtifactSummaryResponse>(
      apiUrl,
      apiToken,
      `/v1/jobs/${encodeURIComponent(jobId)}/artifacts`,
    );
    return response.artifacts;
  } catch {
    return [];
  }
}

function isArtifactFreshForRun(updatedAt: string | null, job: JobSummary): boolean {
  if (!updatedAt) {
    return false;
  }
  const artifactTime = Date.parse(updatedAt);
  const runStart = Date.parse(job.launchedAt || job.startedAt || "");
  if (!Number.isFinite(artifactTime) || !Number.isFinite(runStart)) {
    return true;
  }
  return artifactTime >= runStart - 60_000;
}

async function waitForBriefingReady(
  apiUrl: string,
  apiToken: string,
  finishedJob: JobSummary,
): Promise<string | null> {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    const freshJob = await fetchJob(apiUrl, apiToken, finishedJob.id);
    const artifacts = await fetchArtifacts(apiUrl, apiToken, finishedJob.id);
    const briefingArtifact = artifacts.find((artifact) => artifact.name === "briefing.md");
    if (briefingArtifact && isArtifactFreshForRun(briefingArtifact.updatedAt, freshJob)) {
      const briefing = await fetchBriefing(apiUrl, apiToken, finishedJob.id);
      if (briefing) {
        return briefing;
      }
    }
    await sleep(1500);
  }
  return null;
}

async function cancelJob(apiUrl: string, apiToken: string, jobId: string) {
  await apiFetch(apiUrl, apiToken, `/v1/jobs/${encodeURIComponent(jobId)}/cancel`, {
    method: "POST",
    body: JSON.stringify({}),
  });
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const config = await resolveConfig(args);

  const startedJob = args.attachJobId
    ? await fetchJob(config.apiUrl, config.apiToken, args.attachJobId)
    : await startOrResumeJob(args, config.apiUrl, config.apiToken, config);
  printHeader("Hermes Run Started");
  process.stdout.write(`${summarizeJob(startedJob)}\n`);
  if (startedJob.runDir) {
    process.stdout.write(`run_dir=${startedJob.runDir}\n`);
  }
  if (startedJob.hermesSessionId) {
    process.stdout.write(`hermes_session=${startedJob.hermesSessionId}\n`);
  }
  process.stdout.write("streaming logs...\n");

  let activeJobId = startedJob.id;
  let cancelRequested = false;
  const onSigint = async () => {
    if (!activeJobId) {
      process.exit(130);
      return;
    }
    if (!args.cancelOnSigint) {
      process.stderr.write(`\nLeaving Hermes job ${activeJobId} running on the droplet.\n`);
      process.exit(130);
      return;
    }
    if (cancelRequested) {
      return;
    }
    cancelRequested = true;
    process.stderr.write(`\nCancelling Hermes job ${activeJobId}...\n`);
    try {
      await cancelJob(config.apiUrl, config.apiToken, activeJobId);
    } catch (error) {
      process.stderr.write(`Failed to cancel remote job: ${error instanceof Error ? error.message : String(error)}\n`);
    }
    process.exit(130);
  };
  process.on("SIGINT", () => {
    void onSigint();
  });

  const finishedJob = await waitForCompletion(activeJobId, args, config.apiUrl, config.apiToken);
  activeJobId = "";

  printHeader("Hermes Run Finished");
  process.stdout.write(`${summarizeJob(finishedJob)}\n`);
  if (finishedJob.manifestStatus) {
    process.stdout.write(`manifest_status=${finishedJob.manifestStatus}\n`);
  }
  if (finishedJob.detail) {
    process.stdout.write(`detail=${finishedJob.detail}\n`);
  }

  const briefing = await waitForBriefingReady(config.apiUrl, config.apiToken, finishedJob);
  if (briefing) {
    printHeader("Briefing");
    process.stdout.write(`${briefing.trim()}\n`);
    return;
  }

  const artifacts = await fetchArtifacts(config.apiUrl, config.apiToken, finishedJob.id);
  throw new Error(
    [
      `Hermes job ${finishedJob.id} finished without briefing.md.`,
      artifacts.length > 0 ? `Available artifacts: ${artifacts.map((artifact) => artifact.name).join(", ")}` : "No artifacts were available.",
    ].join(" "),
  );
}

void main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
