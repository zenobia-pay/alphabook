import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const API_ORIGIN = "https://api.alpha-book.org";
const API_BASES = [`${API_ORIGIN}/api/v1`, `${API_ORIGIN}/v1`, API_ORIGIN] as const;

type RunRecord = {
  id: string;
  sessionId: string;
  status: string;
  startedAt: string;
  completedAt: string | null;
};

type Args = {
  sessionId?: string;
  runId?: string;
  sessionUrl?: string;
  includeArtifacts: boolean;
  includeArtifactContents: boolean;
  includeRuntimeInstances: boolean;
  includeLiveRuntime: boolean;
  out?: string;
};

function parseArgs(argv: string[]): Args {
  const args: Args = {
    includeArtifacts: false,
    includeArtifactContents: false,
    includeRuntimeInstances: false,
    includeLiveRuntime: false,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const next = argv[index + 1];
    if ((arg === "--session" || arg === "--session-id") && next) {
      args.sessionId = next;
      index += 1;
      continue;
    }
    if ((arg === "--run" || arg === "--run-id") && next) {
      args.runId = next;
      index += 1;
      continue;
    }
    if (arg === "--url" && next) {
      args.sessionUrl = next;
      index += 1;
      continue;
    }
    if (arg === "--include-artifacts") {
      args.includeArtifacts = true;
      continue;
    }
    if (arg === "--include-artifact-contents") {
      args.includeArtifacts = true;
      args.includeArtifactContents = true;
      continue;
    }
    if (arg === "--include-runtime-instances") {
      args.includeRuntimeInstances = true;
      continue;
    }
    if (arg === "--include-live-runtime") {
      args.includeLiveRuntime = true;
      continue;
    }
    if (arg === "--full") {
      args.includeArtifacts = true;
      args.includeArtifactContents = true;
      args.includeRuntimeInstances = true;
      args.includeLiveRuntime = true;
      continue;
    }
    if (arg === "--out" && next) {
      args.out = next;
      index += 1;
      continue;
    }
  }
  return args;
}

function usage(): never {
  console.error(
    [
      "Usage:",
      "  npm run debug:session -- --url <session-url>",
      "  npm run debug:session -- --session <session-id>",
      "  npm run debug:session -- --run <run-id>",
      "",
      "Flags:",
      "  --include-artifacts",
      "  --include-artifact-contents",
      "  --include-runtime-instances",
      "  --include-live-runtime",
      "  --full",
      "  --out <path>",
    ].join("\n"),
  );
  process.exit(1);
}

function parseSessionIdFromUrl(url: string): string | undefined {
  try {
    const parsed = new URL(url);
    return parsed.searchParams.get("session") ?? undefined;
  } catch {
    return undefined;
  }
}

async function readCookieFromDevVars() {
  const text = await readFile(".dev.vars", "utf8");
  for (const line of text.split(/\r?\n/u)) {
    if (line.startsWith("ALPHABOOK_COOKIE=")) {
      const raw = line.slice("ALPHABOOK_COOKIE=".length);
      return raw.trim().replace(/^["']|["']$/gu, "");
    }
  }
  throw new Error("ALPHABOOK_COOKIE was not found in .dev.vars.");
}

async function fetchJson<T>(url: string, cookie: string): Promise<T> {
  const execFileAsync = promisify(execFile);
  const { stdout } = await execFileAsync("curl", [
    "-sS",
    url,
    "-H", `Cookie: ${cookie}`,
    "-H", "Origin: https://alpha-book.org",
    "-H", "Referer: https://alpha-book.org/",
    "-H", "User-Agent: Mozilla/5.0",
    "-H", "Accept: application/json,text/plain,*/*",
  ], {
    maxBuffer: 200 * 1024 * 1024,
  });
  const text = stdout.toString();
  if (/<!doctype html|<html\b|<head\b|<body\b|<title\b/i.test(text)) {
    throw new Error(`Expected JSON from ${url}, but received HTML instead.`);
  }
  return JSON.parse(text) as T;
}

async function fetchFirstWorkingJson<T>(paths: string[], cookie: string) {
  const failures: string[] = [];
  for (const path of paths) {
    for (const base of API_BASES) {
      const url = `${base}${path}`;
      try {
        return {
          url,
          payload: await fetchJson<T>(url, cookie),
        };
      } catch (error) {
        failures.push(`${url}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  }
  throw new Error(`All candidate endpoints failed:\n${failures.join("\n")}`);
}

async function resolveRunId(sessionId: string, cookie: string) {
  const { payload } = await fetchFirstWorkingJson<{ runs: RunRecord[] }>([
    `/sessions/${sessionId}/runs`,
    "/admin/runs",
  ], cookie);
  const runs = payload.runs
    .filter((run) => run.sessionId === sessionId)
    .sort((left, right) => Date.parse(right.startedAt) - Date.parse(left.startedAt));
  if (runs.length === 0) {
    throw new Error(`No runs found for session ${sessionId}.`);
  }
  return runs[0].id;
}

function buildLogsSuffix(args: Args) {
  const query = new URLSearchParams();
  if (args.includeArtifacts) {
    query.set("includeArtifacts", "1");
  }
  if (args.includeArtifactContents) {
    query.set("includeArtifactContents", "1");
  }
  if (args.includeRuntimeInstances) {
    query.set("includeRuntimeInstances", "1");
  }
  if (args.includeLiveRuntime) {
    query.set("includeLiveRuntime", "1");
  }
  return query.size > 0 ? `?${query.toString()}` : "";
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const sessionId = args.sessionId ?? (args.sessionUrl ? parseSessionIdFromUrl(args.sessionUrl) : undefined);
  if (!sessionId && !args.runId) {
    usage();
  }

  const cookie = await readCookieFromDevVars();
  const runId = args.runId ?? await resolveRunId(sessionId!, cookie);
  const sessionOrUnknown = sessionId ?? "unknown-session";
  const logsSuffix = buildLogsSuffix(args);
  const logPaths = sessionId
    ? [
      `/admin/runs/${runId}/logs${logsSuffix}`,
      `/sessions/${sessionId}/runs/${runId}/logs${logsSuffix}`,
    ]
    : [`/admin/runs/${runId}/logs${logsSuffix}`];
  const { payload, url: logsUrl } = await fetchFirstWorkingJson<Record<string, unknown>>(logPaths, cookie);
  const outPath = resolve(args.out ?? `/tmp/alphabook-run-${runId}.json`);

  await mkdir(dirname(outPath), { recursive: true });
  await writeFile(outPath, JSON.stringify(payload, null, 2), "utf8");

  const runtimeInstances = Array.isArray(payload.runtimeInstances) ? payload.runtimeInstances.length : 0;
  const runEvents = Array.isArray(payload.runEvents) ? payload.runEvents.length : 0;
  const rawLog = Array.isArray(payload.rawLog) ? payload.rawLog.length : 0;
  const artifacts = Array.isArray(payload.artifacts) ? payload.artifacts.length : null;

  console.log(JSON.stringify({
    sessionId: sessionOrUnknown,
    runId,
    outPath,
    logsUrl,
    payloadBytes: Buffer.byteLength(JSON.stringify(payload)),
    runtimeInstances,
    runEvents,
    rawLog,
    artifacts,
  }, null, 2));
}

void main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
