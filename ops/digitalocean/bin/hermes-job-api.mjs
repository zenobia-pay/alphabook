#!/usr/bin/env node

import http from "node:http";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";
import { URL } from "node:url";
import crypto from "node:crypto";

const HOST = process.env.HERMES_JOB_API_HOST || "0.0.0.0";
const PORT = Number.parseInt(process.env.HERMES_JOB_API_PORT || "8788", 10);
const ROOT_DIR = process.env.ROOT_DIR || "/srv/alphabook/repo";
const RUN_ROOT = process.env.RUN_ROOT || "/srv/alphabook/logs/hermes-corpus-research";
const CORPUS_RUN_ROOT = process.env.CORPUS_RUN_ROOT || "/srv/alphabook/logs/corpus-research";
const API_LOG_ROOT = process.env.API_LOG_ROOT || "/srv/alphabook/logs/hermes-job-api";
const API_TOKEN = loadToken();
const CORS_ORIGIN = process.env.HERMES_JOB_API_CORS_ORIGIN || "*";

const PRIMARY_ARTIFACTS = [
  "index.json",
  "manifest.json",
  "briefing.md",
  "dataset.jsonl",
  "dataset.csv",
  "citation-index.json",
  "cost-profile.json",
  "status.json",
  "run.log",
  "stream.log",
  "openai-requests.jsonl",
  "hermes.session.json",
];

await fsp.mkdir(API_LOG_ROOT, { recursive: true });
const serverLogPath = path.join(API_LOG_ROOT, "server.log");

function loadToken() {
  if (process.env.HERMES_JOB_API_TOKEN) {
    return process.env.HERMES_JOB_API_TOKEN.trim();
  }
  const tokenFile = process.env.HERMES_JOB_API_TOKEN_FILE;
  if (!tokenFile) {
    return "";
  }
  try {
    return fs.readFileSync(tokenFile, "utf8").trim();
  } catch {
    return "";
  }
}

function nowIso() {
  return new Date().toISOString();
}

function logLine(message) {
  const line = `${nowIso()} ${message}\n`;
  fs.appendFileSync(serverLogPath, line);
}

function sendJson(res, statusCode, payload) {
  res.writeHead(statusCode, {
    "content-type": "application/json; charset=utf-8",
    "access-control-allow-origin": CORS_ORIGIN,
    "access-control-allow-headers": "content-type, authorization",
    "access-control-allow-methods": "GET,POST,OPTIONS",
  });
  res.end(`${JSON.stringify(payload, null, 2)}\n`);
}

function sendText(res, statusCode, text) {
  res.writeHead(statusCode, {
    "content-type": "text/plain; charset=utf-8",
    "access-control-allow-origin": CORS_ORIGIN,
    "access-control-allow-headers": "content-type, authorization",
    "access-control-allow-methods": "GET,POST,OPTIONS",
  });
  res.end(text);
}

function unauthorized(res) {
  sendJson(res, 401, {
    error: "unauthorized",
    message: "Bearer token required.",
  });
}

function readJson(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch {
    return null;
  }
}

function statSafe(filePath) {
  try {
    return fs.statSync(filePath);
  } catch {
    return null;
  }
}

function isProcessAlive(pid) {
  if (!pid || !Number.isFinite(Number(pid))) {
    return false;
  }
  try {
    process.kill(Number(pid), 0);
    return true;
  } catch {
    return false;
  }
}

function listRunDirs() {
  if (!fs.existsSync(RUN_ROOT)) {
    return [];
  }
  return fs
    .readdirSync(RUN_ROOT, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => path.join(RUN_ROOT, entry.name))
    .sort()
    .reverse();
}

function inferInnerRunDir(runDir) {
  const wrapperIndex = readJson(path.join(runDir, "index.json"));
  if (wrapperIndex?.inner_run_dir && fs.existsSync(wrapperIndex.inner_run_dir)) {
    return wrapperIndex.inner_run_dir;
  }
  const candidateFiles = [
    path.join(runDir, "status.json"),
    path.join(runDir, "summary.json"),
    path.join(runDir, "launcher.log"),
    path.join(runDir, "hermes.stdout.log"),
    path.join(runDir, "hermes.stderr.log"),
    path.join(runDir, "profile-summary.json"),
    path.join(runDir, "command-snapshots.jsonl"),
  ];
  const regex = /\/srv\/alphabook\/logs\/corpus-research\/[A-Za-z0-9._-]+/g;
  const matches = new Set();
  for (const filePath of candidateFiles) {
    try {
      const text = fs.readFileSync(filePath, "utf8");
      for (const match of text.matchAll(regex)) {
        matches.add(match[0]);
      }
    } catch {
      continue;
    }
  }
  const sorted = [...matches].filter((item) => fs.existsSync(item)).sort();
  return sorted.at(-1) || null;
}

function getCostSummary(innerRunDir) {
  if (!innerRunDir) {
    return {
      available: false,
      source: null,
      estimatedCostUsd: null,
      llmCalls: null,
    };
  }
  const costProfile = readJson(path.join(innerRunDir, "cost-profile.json"));
  if (costProfile?.summary) {
    return {
      available: true,
      source: "cost-profile.json",
      estimatedCostUsd: costProfile.summary.estimated_cost_usd ?? null,
      llmCalls: costProfile.summary.llm_calls ?? null,
      phases: costProfile.phases ?? null,
    };
  }
  const status = readJson(path.join(innerRunDir, "status.json"));
  if (status && (status.estimated_cumulative_cost_usd != null || status.llm_calls != null)) {
    return {
      available: true,
      source: "status.json",
      estimatedCostUsd: status.estimated_cumulative_cost_usd ?? null,
      llmCalls: status.llm_calls ?? null,
    };
  }
  return {
    available: false,
    source: null,
    estimatedCostUsd: null,
    llmCalls: null,
  };
}

function summarizeArtifacts(innerRunDir) {
  if (!innerRunDir) {
    return [];
  }
  return PRIMARY_ARTIFACTS.map((name) => {
    const filePath = path.join(innerRunDir, name);
    const stat = statSafe(filePath);
    if (!stat || !stat.isFile()) {
      return null;
    }
    return {
      name,
      path: filePath,
      bytes: stat.size,
      updatedAt: stat.mtime.toISOString(),
    };
  }).filter(Boolean);
}

function parseHeartbeatAt(runDir) {
  const heartbeatPath = path.join(runDir, "heartbeat.log");
  try {
    const lines = fs.readFileSync(heartbeatPath, "utf8").trim().split("\n");
    return lines.at(-1)?.split(" ")[0] || null;
  } catch {
    return null;
  }
}

function getRunSummary(runDir) {
  const jobId = path.basename(runDir);
  const status = readJson(path.join(runDir, "status.json")) || {};
  const summary = readJson(path.join(runDir, "summary.json")) || {};
  const index = readJson(path.join(runDir, "index.json")) || {};
  const effective = { ...summary, ...status };
  const pid = effective.pid ?? null;
  const innerRunDir = index.inner_run_dir || effective.inner_run_dir || inferInnerRunDir(runDir);
  const innerManifest = innerRunDir ? readJson(path.join(innerRunDir, "manifest.json")) : null;
  const innerStatus = innerRunDir ? readJson(path.join(innerRunDir, "status.json")) : null;
  const cost = getCostSummary(innerRunDir);
  const running = isProcessAlive(pid);
  const effectiveState =
    running ? "running" : effective.state === "running" && !effective.finished_at ? "stopped" : effective.state || "unknown";

  return {
    id: jobId,
    runDir,
    innerRunDir,
    innerRunId: index.inner_run_id || effective.inner_run_id || (innerRunDir ? path.basename(innerRunDir) : null),
    state: effectiveState,
    running,
    pid,
    userPrompt: effective.user_prompt || null,
    model: effective.model || null,
    maxTurns: effective.max_turns ?? null,
    launchedAt: effective.launched_at || null,
    startedAt: effective.started_at || null,
    finishedAt: effective.finished_at || null,
    indexFile: path.join(runDir, "index.json"),
    hermesSessionId: index.session?.primary_session_id || effective.hermes_session_id || null,
    hermesSessionFile: index.session?.session_snapshot_file || effective.hermes_session_file || null,
    exitCode: effective.exit_code ?? null,
    heartbeatAt: parseHeartbeatAt(runDir),
    phase: innerStatus?.phase || null,
    phaseProgressPct: innerStatus?.phase_progress_pct ?? null,
    detail: innerStatus?.detail || null,
    manifestStatus: innerManifest?.status || null,
    chosenScope: innerManifest?.chosen_scope || null,
    scopeRationale: innerManifest?.scope_rationale || null,
    recordCounts: innerManifest?.record_counts || null,
    cost,
    openai: index.openai || null,
    artifacts: summarizeArtifacts(innerRunDir),
  };
}

function resolveRunDir(jobId) {
  const runDir = path.join(RUN_ROOT, jobId);
  return fs.existsSync(runDir) ? runDir : null;
}

function getLogSources(runDir) {
  const innerRunDir = inferInnerRunDir(runDir);
  const sources = [
    { name: "launcher", path: path.join(runDir, "launcher.log") },
    { name: "heartbeat", path: path.join(runDir, "heartbeat.log") },
    { name: "hermes_stdout", path: path.join(runDir, "hermes.stdout.log") },
    { name: "hermes_stderr", path: path.join(runDir, "hermes.stderr.log") },
    { name: "wrapper_index", path: path.join(runDir, "index.json") },
    { name: "openai_requests", path: path.join(runDir, "openai-requests.jsonl") },
  ];
  if (innerRunDir) {
    sources.push(
      { name: "run_log", path: path.join(innerRunDir, "run.log") },
      { name: "stream_log", path: path.join(innerRunDir, "stream.log") },
      { name: "inner_status", path: path.join(innerRunDir, "status.json") },
    );
  }
  return sources.filter((source) => statSafe(source.path)?.isFile());
}

function encodeCursor(cursor) {
  return Buffer.from(JSON.stringify(cursor), "utf8").toString("base64url");
}

function decodeCursor(raw) {
  if (!raw) {
    return {};
  }
  try {
    return JSON.parse(Buffer.from(raw, "base64url").toString("utf8"));
  } catch {
    return {};
  }
}

function tailLines(text, limit) {
  const lines = text.split(/\r?\n/).filter((line) => line.length > 0);
  return lines.slice(-limit);
}

async function readLogUpdates(runDir, cursorRaw, limit) {
  const cursor = decodeCursor(cursorRaw);
  const sources = getLogSources(runDir);
  const responseSources = [];
  const nextCursor = {};

  for (const source of sources) {
    const stat = await fsp.stat(source.path);
    const previousOffset = Number(cursor[source.name] || 0);
    if (!Number.isFinite(previousOffset) || previousOffset < 0 || previousOffset > stat.size) {
      nextCursor[source.name] = stat.size;
      responseSources.push({
        name: source.name,
        path: source.path,
        bytes: stat.size,
        updatedAt: stat.mtime.toISOString(),
        lines: tailLines(await fsp.readFile(source.path, "utf8"), limit),
      });
      continue;
    }

    if (!cursorRaw) {
      nextCursor[source.name] = stat.size;
      responseSources.push({
        name: source.name,
        path: source.path,
        bytes: stat.size,
        updatedAt: stat.mtime.toISOString(),
        lines: tailLines(await fsp.readFile(source.path, "utf8"), limit),
      });
      continue;
    }

    const handle = await fsp.open(source.path, "r");
    const length = stat.size - previousOffset;
    const buffer = Buffer.alloc(length);
    await handle.read(buffer, 0, length, previousOffset);
    await handle.close();
    nextCursor[source.name] = stat.size;
    responseSources.push({
      name: source.name,
      path: source.path,
      bytes: stat.size,
      updatedAt: stat.mtime.toISOString(),
      lines: buffer
        .toString("utf8")
        .split(/\r?\n/)
        .filter((line) => line.length > 0)
        .slice(-limit),
    });
  }

  return {
    sources: responseSources,
    nextCursor: encodeCursor(nextCursor),
  };
}

async function parseBody(req) {
  const chunks = [];
  for await (const chunk of req) {
    chunks.push(chunk);
  }
  if (chunks.length === 0) {
    return {};
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

async function launchJob(payload) {
  const userPrompt = String(payload.userPrompt || "").trim();
  if (!userPrompt) {
    throw new Error("userPrompt is required");
  }

  const args = [path.join(ROOT_DIR, "ops/digitalocean/bin/run-hermes-corpus-research.sh"), "--user-prompt", userPrompt];
  if (payload.model) {
    args.push("--model", String(payload.model));
  }
  if (payload.maxTurns) {
    args.push("--max-turns", String(payload.maxTurns));
  }
  if (payload.corpusRoot) {
    args.push("--corpus-root", String(payload.corpusRoot));
  }

  return await new Promise((resolve, reject) => {
    const child = spawn(args[0], args.slice(1), {
      cwd: ROOT_DIR,
      env: {
        ...process.env,
        ROOT_DIR,
        RUN_ROOT,
      },
    });

    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString("utf8");
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString("utf8");
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code !== 0) {
        reject(new Error(stderr || stdout || `launcher exited with code ${code}`));
        return;
      }
      const runDir = stdout.trim().split(/\r?\n/).filter(Boolean).at(-1);
      if (!runDir) {
        reject(new Error("launcher did not return a run directory"));
        return;
      }
      resolve(getRunSummary(runDir));
    });
  });
}

function checkAuth(req) {
  if (!API_TOKEN) {
    return true;
  }
  const header = req.headers.authorization || "";
  return header === `Bearer ${API_TOKEN}`;
}

const server = http.createServer(async (req, res) => {
  try {
    const requestUrl = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);
    if (req.method === "OPTIONS") {
      sendText(res, 204, "");
      return;
    }

    if (!checkAuth(req)) {
      unauthorized(res);
      return;
    }

    if (req.method === "GET" && requestUrl.pathname === "/health") {
      sendJson(res, 200, {
        ok: true,
        now: nowIso(),
        runRoot: RUN_ROOT,
        corpusRunRoot: CORPUS_RUN_ROOT,
      });
      return;
    }

    if (req.method === "GET" && requestUrl.pathname === "/v1/jobs") {
      const limit = Math.max(1, Math.min(100, Number.parseInt(requestUrl.searchParams.get("limit") || "20", 10)));
      const jobs = listRunDirs().slice(0, limit).map(getRunSummary);
      sendJson(res, 200, { jobs });
      return;
    }

    if (req.method === "GET" && requestUrl.pathname === "/v1/jobs/active") {
      const jobs = listRunDirs().map(getRunSummary).filter((job) => job.running);
      sendJson(res, 200, { jobs });
      return;
    }

    if (req.method === "POST" && requestUrl.pathname === "/v1/jobs") {
      const payload = await parseBody(req);
      const job = await launchJob(payload);
      logLine(`job_submitted id=${job.id} prompt_sha=${crypto.createHash("sha1").update(String(payload.userPrompt)).digest("hex").slice(0, 12)}`);
      sendJson(res, 202, { job });
      return;
    }

    const jobMatch = requestUrl.pathname.match(/^\/v1\/jobs\/([^/]+)$/);
    if (req.method === "GET" && jobMatch) {
      const runDir = resolveRunDir(jobMatch[1]);
      if (!runDir) {
        sendJson(res, 404, { error: "not_found" });
        return;
      }
      sendJson(res, 200, { job: getRunSummary(runDir) });
      return;
    }

    const logMatch = requestUrl.pathname.match(/^\/v1\/jobs\/([^/]+)\/logs$/);
    if (req.method === "GET" && logMatch) {
      const runDir = resolveRunDir(logMatch[1]);
      if (!runDir) {
        sendJson(res, 404, { error: "not_found" });
        return;
      }
      const limit = Math.max(1, Math.min(500, Number.parseInt(requestUrl.searchParams.get("limit") || "100", 10)));
      const logs = await readLogUpdates(runDir, requestUrl.searchParams.get("cursor"), limit);
      sendJson(res, 200, {
        jobId: logMatch[1],
        ...logs,
      });
      return;
    }

    const artifactsMatch = requestUrl.pathname.match(/^\/v1\/jobs\/([^/]+)\/artifacts$/);
    if (req.method === "GET" && artifactsMatch) {
      const runDir = resolveRunDir(artifactsMatch[1]);
      if (!runDir) {
        sendJson(res, 404, { error: "not_found" });
        return;
      }
      const summary = getRunSummary(runDir);
      sendJson(res, 200, {
        jobId: artifactsMatch[1],
        runDir,
        innerRunDir: summary.innerRunDir,
        artifacts: summary.artifacts,
      });
      return;
    }

    sendJson(res, 404, { error: "not_found" });
  } catch (error) {
    logLine(`request_error ${error instanceof Error ? error.stack || error.message : String(error)}`);
    sendJson(res, 500, {
      error: "internal_error",
      message: error instanceof Error ? error.message : String(error),
    });
  }
});

server.listen(PORT, HOST, () => {
  logLine(`server_started host=${HOST} port=${PORT} run_root=${RUN_ROOT}`);
  console.log(`Hermes job API listening on http://${HOST}:${PORT}`);
});
