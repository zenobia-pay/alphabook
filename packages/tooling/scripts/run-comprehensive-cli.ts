import process from "node:process";
import { readFile } from "node:fs/promises";

import { loadDotEnvFile } from "./lib/benchmark-env.ts";

type Args = {
  prompt?: string;
  attachJobId?: string;
  apiBaseUrl?: string;
  cookie?: string;
  sessionId?: string;
  userId?: string;
  workIds: string[];
  mode: "comprehensive" | "semantic";
  intensityOverride?: "normal" | "high" | "maximum";
  semanticBackend?: "alphaloop" | "context1";
  pollMs: number;
  logLimit: number;
  cancelOnSigint: boolean;
};

type JobSummary = {
  id: string;
  ownerUserId?: string | null;
  prompt: string;
  mode: "comprehensive" | "semantic";
  state: string;
  running: boolean;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  sessionId: string | null;
  runId: string | null;
  detail: string | null;
  error: string | null;
  cancelRequestedAt: string | null;
};

type JobResponse = {
  job: JobSummary;
};

type LogsResponse = {
  jobId: string;
  sources: Array<{
    name: string;
    lines: string[];
  }>;
  nextCursor: string;
};

type ArtifactResponse = {
  artifact: {
    name: string;
    content: string;
    updatedAt: string | null;
    mimeType: string;
  };
};

type ArtifactSummaryResponse = {
  artifacts: Array<{
    name: string;
    updatedAt: string | null;
    mimeType: string;
    byteSize: number | null;
  }>;
};

function usage(): never {
  console.error(
    [
      "Usage:",
      "  npm run research:comprehensive -- --prompt \"Find me examples...\"",
      "",
      "Options:",
      "  --prompt <text>              User prompt to send to the comprehensive job API",
      "  --attach-job-id <id>         Inspect an existing comprehensive job",
      "  --api-base-url <url>         API base URL (default https://api.alpha-book.org)",
      "  --cookie <cookie>            Explicit alphabook_session cookie string",
      "  --session-id <uuid>          Continue an existing session",
      "  --user-id <id>               Explicit user id when auth is disabled",
      "  --work-id <id>               Scope the run to a work id (repeatable)",
      "  --mode <mode>                comprehensive | semantic (default comprehensive)",
      "  --intensity-override <lvl>   normal | high | maximum",
      "  --semantic-backend <name>    alphaloop | context1",
      "  --poll-ms <ms>               Poll interval (default 3000)",
      "  --log-limit <n>              Max log lines per poll (default 200)",
      "  --no-cancel-on-sigint        Do not try to cancel the remote job on Ctrl-C",
      "",
      "Environment:",
      "  ALPHABOOK_COOKIE",
      "  ALPHABOOK_API_BASE_URL",
    ].join("\n"),
  );
  process.exit(1);
}

function parseArgs(argv: string[]): Args {
  const args: Args = {
    workIds: [],
    mode: "comprehensive",
    pollMs: 3000,
    logLimit: 200,
    cancelOnSigint: true,
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
    if (arg === "--api-base-url" && next) {
      args.apiBaseUrl = next;
      index += 1;
      continue;
    }
    if (arg === "--cookie" && next) {
      args.cookie = next;
      index += 1;
      continue;
    }
    if (arg === "--session-id" && next) {
      args.sessionId = next;
      index += 1;
      continue;
    }
    if (arg === "--user-id" && next) {
      args.userId = next;
      index += 1;
      continue;
    }
    if (arg === "--work-id" && next) {
      args.workIds.push(next);
      index += 1;
      continue;
    }
    if (arg === "--mode" && next && (next === "comprehensive" || next === "semantic")) {
      args.mode = next;
      index += 1;
      continue;
    }
    if (arg === "--intensity-override" && next && (next === "normal" || next === "high" || next === "maximum")) {
      args.intensityOverride = next;
      index += 1;
      continue;
    }
    if (arg === "--semantic-backend" && next && (next === "alphaloop" || next === "context1")) {
      args.semanticBackend = next;
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
    if (arg === "--no-cancel-on-sigint") {
      args.cancelOnSigint = false;
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
  return args;
}

async function readCookieFromDevVars(): Promise<string | null> {
  try {
    const text = await readFile(".dev.vars", "utf8");
    for (const line of text.split(/\r?\n/u)) {
      if (line.startsWith("ALPHABOOK_COOKIE=")) {
        return line.slice("ALPHABOOK_COOKIE=".length).trim().replace(/^["']|["']$/gu, "");
      }
    }
  } catch {
    return null;
  }
  return null;
}

async function resolveConfig(args: Args) {
  try {
    await loadDotEnvFile(".dev.vars");
  } catch {
    // Optional for local tooling.
  }
  const apiBaseUrl = (args.apiBaseUrl || process.env.ALPHABOOK_API_BASE_URL || "https://api.alpha-book.org").replace(/\/+$/u, "");
  const cookie = args.cookie || process.env.ALPHABOOK_COOKIE || await readCookieFromDevVars();
  return { apiBaseUrl, cookie: cookie ?? null };
}

async function apiFetch<T>(
  apiBaseUrl: string,
  cookie: string | null,
  pathname: string,
  init?: RequestInit,
): Promise<T> {
  const response = await fetch(`${apiBaseUrl}${pathname}`, {
    ...init,
    headers: {
      "content-type": "application/json",
      ...(cookie ? {
        Cookie: cookie,
        Origin: "https://alpha-book.org",
        Referer: "https://alpha-book.org/",
        "User-Agent": "Mozilla/5.0",
        Accept: "application/json,text/plain,*/*",
      } : {}),
      ...(init?.headers || {}),
    },
  });
  const text = await response.text();
  if (!response.ok) {
    throw new Error(`${response.status} ${response.statusText}: ${text}`);
  }
  return text ? JSON.parse(text) as T : {} as T;
}

function printHeader(title: string) {
  process.stdout.write(`\n=== ${title} ===\n`);
}

function summarizeJob(job: JobSummary): string {
  return [
    `job=${job.id}`,
    `mode=${job.mode}`,
    `state=${job.state}`,
    job.sessionId ? `session=${job.sessionId}` : null,
    job.runId ? `run=${job.runId}` : null,
  ].filter(Boolean).join(" ");
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function createJob(
  args: Args,
  apiBaseUrl: string,
  cookie: string | null,
): Promise<JobSummary> {
  const payload: Record<string, unknown> = {
    prompt: args.prompt,
    mode: args.mode,
  };
  if (args.sessionId) {
    payload.sessionId = args.sessionId;
  }
  if (args.userId) {
    payload.userId = args.userId;
  }
  if (args.workIds.length > 0) {
    payload.workIds = args.workIds;
  }
  if (args.intensityOverride) {
    payload.intensityOverride = args.intensityOverride;
  }
  if (args.semanticBackend) {
    payload.semanticBackend = args.semanticBackend;
  }
  const response = await apiFetch<JobResponse>(apiBaseUrl, cookie, "/v1/comprehensive-jobs", {
    method: "POST",
    body: JSON.stringify(payload),
  });
  return response.job;
}

async function fetchJob(
  apiBaseUrl: string,
  cookie: string | null,
  jobId: string,
): Promise<JobSummary> {
  const response = await apiFetch<JobResponse>(apiBaseUrl, cookie, `/v1/comprehensive-jobs/${encodeURIComponent(jobId)}`);
  return response.job;
}

async function fetchLogs(
  apiBaseUrl: string,
  cookie: string | null,
  jobId: string,
  cursor: string | undefined,
  limit: number,
): Promise<LogsResponse> {
  return apiFetch<LogsResponse>(
    apiBaseUrl,
    cookie,
    `/v1/comprehensive-jobs/${encodeURIComponent(jobId)}/logs?limit=${limit}${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`,
  );
}

async function fetchArtifacts(
  apiBaseUrl: string,
  cookie: string | null,
  jobId: string,
): Promise<ArtifactSummaryResponse["artifacts"]> {
  try {
    const response = await apiFetch<ArtifactSummaryResponse>(
      apiBaseUrl,
      cookie,
      `/v1/comprehensive-jobs/${encodeURIComponent(jobId)}/artifacts`,
    );
    return response.artifacts;
  } catch {
    return [];
  }
}

async function fetchArtifact(
  apiBaseUrl: string,
  cookie: string | null,
  jobId: string,
  artifactName: string,
): Promise<string | null> {
  try {
    const response = await apiFetch<ArtifactResponse>(
      apiBaseUrl,
      cookie,
      `/v1/comprehensive-jobs/${encodeURIComponent(jobId)}/artifacts/${encodeURIComponent(artifactName)}`,
    );
    return response.artifact.content;
  } catch {
    return null;
  }
}

async function cancelJob(
  apiBaseUrl: string,
  cookie: string | null,
  jobId: string,
) {
  await apiFetch(apiBaseUrl, cookie, `/v1/comprehensive-jobs/${encodeURIComponent(jobId)}/cancel`, {
    method: "POST",
    body: JSON.stringify({}),
  });
}

async function waitForCompletion(
  args: Args,
  apiBaseUrl: string,
  cookie: string | null,
  jobId: string,
): Promise<JobSummary> {
  let cursor: string | undefined;
  while (true) {
    const logs = await fetchLogs(apiBaseUrl, cookie, jobId, cursor, args.logLimit);
    for (const source of logs.sources) {
      for (const line of source.lines) {
        process.stdout.write(`[${source.name}] ${line}\n`);
      }
    }
    cursor = logs.nextCursor;
    const job = await fetchJob(apiBaseUrl, cookie, jobId);
    if (!job.running) {
      // Drain one final time after the job reaches a terminal state so late
      // shard run-status/proxy logs are not skipped by the last poll boundary.
      while (true) {
        const finalLogs = await fetchLogs(apiBaseUrl, cookie, jobId, cursor, args.logLimit);
        let printed = 0;
        for (const source of finalLogs.sources) {
          for (const line of source.lines) {
            process.stdout.write(`[${source.name}] ${line}\n`);
            printed += 1;
          }
        }
        if (finalLogs.nextCursor === cursor || printed === 0) {
          break;
        }
        cursor = finalLogs.nextCursor;
      }
      return job;
    }
    await sleep(args.pollMs);
  }
}

async function waitForBriefing(
  apiBaseUrl: string,
  cookie: string | null,
  jobId: string,
): Promise<string | null> {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    const artifacts = await fetchArtifacts(apiBaseUrl, cookie, jobId);
    const briefing = artifacts.find((artifact) =>
      artifact.name === "briefing.md" || artifact.name === "briefing.json",
    );
    if (briefing) {
      return await fetchArtifact(apiBaseUrl, cookie, jobId, briefing.name);
    }
    await sleep(1500);
  }
  return null;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const config = await resolveConfig(args);

  const startedJob = args.attachJobId
    ? await fetchJob(config.apiBaseUrl, config.cookie, args.attachJobId)
    : await createJob(args, config.apiBaseUrl, config.cookie);
  printHeader("Comprehensive Job Started");
  process.stdout.write(`${summarizeJob(startedJob)}\n`);
  if (startedJob.prompt) {
    process.stdout.write(`prompt=${startedJob.prompt}\n`);
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
      process.stderr.write(`\nLeaving comprehensive job ${activeJobId} running.\n`);
      process.exit(130);
      return;
    }
    if (cancelRequested) {
      return;
    }
    cancelRequested = true;
    process.stderr.write(`\nCancelling comprehensive job ${activeJobId}...\n`);
    try {
      await cancelJob(config.apiBaseUrl, config.cookie, activeJobId);
    } catch (error) {
      process.stderr.write(`Failed to cancel remote job: ${error instanceof Error ? error.message : String(error)}\n`);
    }
    process.exit(130);
  };
  process.on("SIGINT", () => {
    void onSigint();
  });

  const finishedJob = await waitForCompletion(args, config.apiBaseUrl, config.cookie, activeJobId);
  activeJobId = "";

  printHeader("Comprehensive Job Finished");
  process.stdout.write(`${summarizeJob(finishedJob)}\n`);
  if (finishedJob.detail) {
    process.stdout.write(`detail=${finishedJob.detail}\n`);
  }
  if (finishedJob.error) {
    process.stdout.write(`error=${finishedJob.error}\n`);
  }

  const briefing = finishedJob.state === "completed"
    ? await waitForBriefing(config.apiBaseUrl, config.cookie, finishedJob.id)
    : null;
  if (briefing) {
    printHeader("Artifact");
    process.stdout.write(`${briefing.trim()}\n`);
  }

  if (finishedJob.state !== "completed") {
    process.exit(1);
  }
}

void main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
