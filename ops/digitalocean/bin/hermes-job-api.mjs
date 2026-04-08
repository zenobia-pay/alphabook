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
const RESEARCH_RUN_ROOT = process.env.RUN_ROOT || "/srv/alphabook/logs/hermes-corpus-research";
const SEARCH_RUN_ROOT = process.env.SEARCH_RUN_ROOT || "/srv/alphabook/logs/hermes-search";
const SEMANTIC_RUN_ROOT = process.env.SEMANTIC_RUN_ROOT || "/srv/alphabook/logs/semantic-search";
const CORPUS_RUN_ROOT = process.env.CORPUS_RUN_ROOT || "/srv/alphabook/logs/corpus-research";
const SEARCH_CORPUS_RUN_ROOT = process.env.SEARCH_CORPUS_RUN_ROOT || "/srv/alphabook/logs/corpus-search";
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
  "query-expansion.json",
  "progress-summary.json",
  "summary.json",
  "timing-log.jsonl",
  "hydrated-hits.jsonl",
  "review-packets.jsonl",
  "reranked-packets.jsonl",
  "status.json",
  "run.log",
  "stream.log",
  "openai-requests.jsonl",
  "hermes.session.json",
];

function normalizeArtifactName(input) {
  return decodeURIComponent(String(input || ""))
    .replaceAll("\\", "/")
    .replace(/^\/+/u, "")
    .trim();
}

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

function getWrapperRunRoots() {
  return [RESEARCH_RUN_ROOT, SEARCH_RUN_ROOT, SEMANTIC_RUN_ROOT];
}

function listRunDirs() {
  const seen = new Set();
  const dirs = [];
  for (const root of getWrapperRunRoots()) {
    if (!fs.existsSync(root)) {
      continue;
    }
    for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
      if (!entry.isDirectory()) {
        continue;
      }
      const runDir = path.join(root, entry.name);
      if (seen.has(runDir)) {
        continue;
      }
      seen.add(runDir);
      dirs.push(runDir);
    }
  }
  return dirs.sort().reverse();
}

function inferInnerRunDir(runDir) {
  const explicitPath = path.join(runDir, "inner-run-dir.txt");
  try {
    const explicitValue = fs.readFileSync(explicitPath, "utf8").trim();
    if (explicitValue && fs.existsSync(explicitValue)) {
      return explicitValue;
    }
  } catch {}
  for (const filename of ["index.json", "status.json", "summary.json"]) {
    const payload = readJson(path.join(runDir, filename));
    if (payload?.inner_run_dir && statSafe(payload.inner_run_dir)?.isDirectory()) {
      return payload.inner_run_dir;
    }
  }
  try {
    const stdoutLog = fs.readFileSync(path.join(runDir, "hermes.stdout.log"), "utf8");
    const matches = [...stdoutLog.matchAll(/\/srv\/alphabook\/logs\/corpus-(?:search|research)\/[^\s"'`]+/gu)];
    for (let index = matches.length - 1; index >= 0; index -= 1) {
      const candidate = matches[index]?.[0]?.trim();
      if (candidate && statSafe(candidate)?.isDirectory()) {
        return candidate;
      }
    }
  } catch {}
  return null;
}

function isUserFacingHermesArtifactName(name) {
  const normalized = String(name || "").replaceAll("\\", "/").replace(/^\/+/u, "").toLowerCase();
  if (
    normalized === "manifest.json"
    || normalized === "run.log"
    || normalized === "scoped-files.tsv"
    || normalized === "briefing.md"
    || normalized === "dataset.csv"
    || normalized === "dataset.jsonl"
    || normalized === "citation-index.json"
    || normalized === "status.json"
    || normalized === "hits/index.json"
  ) {
    return true;
  }
  return /^hits\/hit-\d+\.md$/u.test(normalized);
}

function summarizeUserFacingArtifacts(innerRunDir) {
  return summarizeArtifacts(innerRunDir).filter((artifact) => isUserFacingHermesArtifactName(artifact.name));
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
  const artifacts = [];
  const seen = new Set();
  for (const name of PRIMARY_ARTIFACTS) {
    const filePath = path.join(innerRunDir, name);
    const stat = statSafe(filePath);
    if (!stat || !stat.isFile()) {
      continue;
    }
    artifacts.push({
      name,
      path: filePath,
      bytes: stat.size,
      updatedAt: stat.mtime.toISOString(),
    });
    seen.add(name);
  }
  const hitsDir = path.join(innerRunDir, "hits");
  try {
    for (const entry of fs.readdirSync(hitsDir, { withFileTypes: true })) {
      if (!entry.isFile()) {
        continue;
      }
      const relativeName = `hits/${entry.name}`;
      if (seen.has(relativeName)) {
        continue;
      }
      const filePath = path.join(hitsDir, entry.name);
      const stat = statSafe(filePath);
      if (!stat || !stat.isFile()) {
        continue;
      }
      artifacts.push({
        name: relativeName,
        path: filePath,
        bytes: stat.size,
        updatedAt: stat.mtime.toISOString(),
      });
      seen.add(relativeName);
    }
  } catch {
    // Ignore missing search hit directories.
  }
  return artifacts;
}

function summarizeArchive(runDir) {
  const index = readJson(path.join(runDir, "index.json")) || {};
  const status = readJson(path.join(runDir, "status.json")) || {};
  const archive = (index.archive && typeof index.archive === "object" ? index.archive : null)
    || (status.archive && typeof status.archive === "object" ? status.archive : null);
  if (!archive) {
    return null;
  }
  return {
    status: typeof archive.status === "string" ? archive.status : null,
    prefix: typeof archive.prefix === "string" ? archive.prefix : null,
    manifestKey: typeof archive.manifestKey === "string" ? archive.manifestKey : null,
    fileCount: typeof archive.fileCount === "number" ? archive.fileCount : null,
    updatedAt: typeof archive.updatedAt === "string" ? archive.updatedAt : null,
  };
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
  const bridge = (index.bridge && typeof index.bridge === "object") ? index.bridge : {};
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
    jobType: index.job_type || effective.job_type || null,
    runDir,
    wrapperRunDir: typeof bridge.wrapperRunDir === "string" ? bridge.wrapperRunDir : runDir,
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
    hermesSessionId: typeof bridge.hermesSessionId === "string" ? bridge.hermesSessionId : (effective.hermes_session_id || null),
    hermesSessionFile: index.session?.session_snapshot_file || effective.hermes_session_file || null,
    archivePrefix: typeof bridge.archivePrefix === "string"
      ? bridge.archivePrefix
      : (typeof effective.archive_prefix === "string" ? effective.archive_prefix : null),
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
    artifacts: summarizeUserFacingArtifacts(innerRunDir),
    archive: summarizeArchive(runDir),
  };
}

function resolveRunDir(jobId) {
  for (const root of getWrapperRunRoots()) {
    const runDir = path.join(root, jobId);
    if (fs.existsSync(runDir)) {
      return runDir;
    }
  }
  return null;
}

function normalizeWorkflow(value) {
  if (value === "search" || value === "design_experiment" || value === "auto") {
    return value;
  }
  return null;
}

function normalizeJobType(value) {
  if (value === "semantic_search" || value === "hermes") {
    return value;
  }
  return null;
}

function resolveLauncherConfig(payload) {
  const jobType = normalizeJobType(payload.jobType);
  const workflow = normalizeWorkflow(payload.workflow);
  const effort = Number.parseInt(String(payload.effort ?? ""), 10);
  if (jobType === "semantic_search") {
    const maxResults = Number.parseInt(String(payload.maxResults ?? ""), 10);
    return {
      jobType: "semantic_search",
      workflow: "search",
      launcherPath: path.join(ROOT_DIR, "ops/digitalocean/bin/run-semantic-search-job.sh"),
      runRoot: SEMANTIC_RUN_ROOT,
      innerRunRoot: null,
      promptArgName: "--query",
      extraArgs: [
        "--max-results",
        String(Number.isFinite(maxResults) && maxResults > 0 ? maxResults : 8),
        ...(payload.backend ? ["--backend", String(payload.backend)] : []),
        ...(
          Array.isArray(payload.gutenbergIds)
            ? payload.gutenbergIds.flatMap((value) => String(value || "").trim() ? ["--gutenberg-id", String(value).trim()] : [])
            : []
        ),
      ],
    };
  }
  if (workflow === "search") {
    return {
      jobType: "hermes",
      workflow,
      launcherPath: path.join(ROOT_DIR, "ops/digitalocean/bin/run-hermes-search.sh"),
      runRoot: SEARCH_RUN_ROOT,
      innerRunRoot: SEARCH_CORPUS_RUN_ROOT,
      promptArgName: "--user-prompt",
      extraArgs: ["--effort", String(Number.isFinite(effort) && effort > 0 ? effort : 10)],
    };
  }
  return {
    jobType: "hermes",
    workflow: workflow ?? "auto",
    launcherPath: path.join(ROOT_DIR, "ops/digitalocean/bin/run-hermes-corpus-research.sh"),
    runRoot: RESEARCH_RUN_ROOT,
    innerRunRoot: CORPUS_RUN_ROOT,
    promptArgName: "--user-prompt",
    extraArgs: [],
  };
}

function resolveArtifactPath(runDir, artifactName) {
  const normalizedName = normalizeArtifactName(artifactName);
  if (!normalizedName || normalizedName === "." || normalizedName === ".." || normalizedName.includes("../")) {
    return null;
  }
  const innerRunDir = inferInnerRunDir(runDir);
  const candidates = [
    path.join(runDir, normalizedName),
    path.join(runDir, "openai-proxy", normalizedName),
    innerRunDir ? path.join(innerRunDir, normalizedName) : null,
    path.join(runDir, path.basename(normalizedName)),
    path.join(runDir, "openai-proxy", path.basename(normalizedName)),
    innerRunDir ? path.join(innerRunDir, path.basename(normalizedName)) : null,
  ].filter(Boolean);
  for (const candidate of candidates) {
    const stat = statSafe(candidate);
    if (stat?.isFile()) {
      return candidate;
    }
  }
  return null;
}

function getCuratedLogSources(runDir) {
  const innerRunDir = inferInnerRunDir(runDir);
  const sources = [
    { name: "launcher", path: path.join(runDir, "launcher.log") },
    { name: "heartbeat", path: path.join(runDir, "heartbeat.log") },
    { name: "process", path: path.join(runDir, "process.log") },
    { name: "hermes_stdout", path: path.join(runDir, "hermes.stdout.log") },
    { name: "hermes_stderr", path: path.join(runDir, "hermes.stderr.log") },
    { name: "wrapper_index", path: path.join(runDir, "index.json") },
    { name: "inner_run_file", path: path.join(runDir, "inner-run-dir.txt") },
    { name: "openai_requests", path: path.join(runDir, "openai-requests.jsonl") },
  ];
  if (innerRunDir) {
    sources.push(
      { name: "run_log", path: path.join(innerRunDir, "run.log") },
      { name: "stream_log", path: path.join(innerRunDir, "stream.log") },
      { name: "inner_status", path: path.join(innerRunDir, "status.json") },
    );
    for (const semanticSource of [
      { name: "progress_summary", path: path.join(innerRunDir, "progress-summary.json") },
      { name: "timing_log", path: path.join(innerRunDir, "timing-log.jsonl") },
      { name: "query_expansion", path: path.join(innerRunDir, "query-expansion.json") },
      { name: "retrieval_summary", path: path.join(innerRunDir, "summary.json") },
    ]) {
      if (statSafe(semanticSource.path)?.isFile()) {
        sources.push(semanticSource);
      }
    }
    const searchDir = path.join(innerRunDir, "search");
    try {
      for (const entry of fs.readdirSync(searchDir, { withFileTypes: true })) {
        if (!entry.isDirectory()) {
          continue;
        }
        const progressPath = path.join(searchDir, entry.name, "ripgrep-progress.jsonl");
        const statusPath = path.join(searchDir, entry.name, "ripgrep-status.json");
        if (statSafe(progressPath)?.isFile()) {
          sources.push({ name: `ripgrep_progress:${entry.name}`, path: progressPath });
        }
        if (statSafe(statusPath)?.isFile()) {
          sources.push({ name: `ripgrep_status:${entry.name}`, path: statusPath });
        }
      }
    } catch {
      // Ignore missing or unreadable search directories.
    }
  }
  return sources.filter((source) => statSafe(source.path)?.isFile());
}

function isOperationalLogFile(rootDir, filePath) {
  const relativePath = path.relative(rootDir, filePath).replaceAll(path.sep, "/");
  const extension = path.extname(filePath).toLowerCase();
  const baseName = path.basename(filePath).toLowerCase();

  if (
    relativePath.startsWith("hermes-home/.hermes/skills/") ||
    relativePath.startsWith("hermes-home/.hermes/plugins/") ||
    relativePath.startsWith("hermes-home/.hermes/.skills/")
  ) {
    return false;
  }

  if (
    [
      ".log",
      ".jsonl",
      ".request.json",
      ".response.json",
    ].some((suffix) => relativePath.endsWith(suffix))
  ) {
    return true;
  }

  if (![".json", ".txt", ".md", ".csv", ".tsv", ".yaml", ".yml", ".svg"].includes(extension)) {
    return false;
  }

  return [
    "run",
    "stream",
    "status",
    "summary",
    "index",
    "manifest",
    "prompt",
    "session",
    "process",
    "command",
    "profile",
    "heartbeat",
    "request",
    "response",
    "briefing",
    "theme",
  ].some((token) => baseName.includes(token));
}

function collectTextFiles(rootDir, prefix) {
  if (!rootDir || !fs.existsSync(rootDir)) {
    return [];
  }
  const files = [];
  const walk = (currentDir) => {
    for (const entry of fs.readdirSync(currentDir, { withFileTypes: true })) {
      const fullPath = path.join(currentDir, entry.name);
      if (entry.isDirectory()) {
        walk(fullPath);
        continue;
      }
      if (!entry.isFile() || !isOperationalLogFile(rootDir, fullPath)) {
        continue;
      }
      const relative = path.relative(rootDir, fullPath);
      files.push({
        name: `${prefix}/${relative.replaceAll(path.sep, "/")}`,
        path: fullPath,
      });
    }
  };
  walk(rootDir);
  return files;
}

function getLogSources(runDir, mode = "curated") {
  if (mode !== "all") {
    return getCuratedLogSources(runDir);
  }
  const innerRunDir = inferInnerRunDir(runDir);
  const deduped = new Map();
  for (const source of [
    ...collectTextFiles(runDir, "wrapper"),
    ...collectTextFiles(innerRunDir, "inner"),
  ]) {
    if (statSafe(source.path)?.isFile()) {
      deduped.set(source.path, source);
    }
  }
  return [...deduped.values()]
    .filter((source) => {
      const normalizedPath = source.path.replaceAll(path.sep, "/");
      return ![
        "/hermes-home/.hermes/skills/",
        "/hermes-home/.hermes/plugins/",
        "/hermes-home/.hermes/.skills/",
        "/hermes-home/.hermes/config.yaml",
        "/hermes-home/.hermes/.skills_prompt_snapshot.json",
      ].some((needle) => normalizedPath.includes(needle));
    })
    .sort((left, right) => left.name.localeCompare(right.name));
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

async function readLogUpdates(runDir, cursorRaw, limit, mode = "curated") {
  const cursor = decodeCursor(cursorRaw);
  const sources = getLogSources(runDir, mode);
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
  const launcher = resolveLauncherConfig(payload);
  const promptValue = launcher.jobType === "semantic_search"
    ? String(payload.query || "").trim()
    : String(payload.userPrompt || "").trim();
  if (!promptValue) {
    throw new Error(launcher.jobType === "semantic_search" ? "query is required" : "userPrompt is required");
  }

  const args = [launcher.launcherPath, launcher.promptArgName, promptValue, ...launcher.extraArgs];
  if (payload.model) {
    args.push("--model", String(payload.model));
  }
  if (payload.maxTurns) {
    args.push("--max-turns", String(payload.maxTurns));
  }
  if (payload.corpusRoot) {
    args.push("--corpus-root", String(payload.corpusRoot));
  }
  if (payload.alphabookSessionId) {
    args.push("--alphabook-session-id", String(payload.alphabookSessionId));
  }
  if (payload.alphabookRunId) {
    args.push("--alphabook-run-id", String(payload.alphabookRunId));
  }
  if (payload.callbackUrl) {
    args.push("--callback-url", String(payload.callbackUrl));
  }
  if (payload.callbackToken) {
    args.push("--callback-token", String(payload.callbackToken));
  }
  if (payload.archivePrefix) {
    args.push("--archive-prefix", String(payload.archivePrefix));
  }

  return await new Promise((resolve, reject) => {
    const child = spawn(args[0], args.slice(1), {
      cwd: ROOT_DIR,
      env: {
        ...process.env,
        ROOT_DIR,
        RUN_ROOT: launcher.runRoot,
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

async function resumeJob(payload) {
  const userPrompt = String(payload.userPrompt || "").trim();
  const previousJobId = String(payload.previousJobId || "").trim();
  if (!userPrompt) {
    throw new Error("userPrompt is required");
  }
  if (!previousJobId) {
    throw new Error("previousJobId is required");
  }
  const previousRunDir = resolveRunDir(previousJobId);
  if (!previousRunDir) {
    throw new Error(`previous job not found: ${previousJobId}`);
  }
  const previousSummary = getRunSummary(previousRunDir);
  const resumeSessionId = String(payload.hermesSessionId || previousSummary.hermesSessionId || "").trim();
  const launcher = resolveLauncherConfig(payload);
  if (launcher.workflow === "search" || launcher.jobType === "semantic_search") {
    throw new Error("Hermes search jobs do not support resume yet.");
  }
  const args = [
    launcher.launcherPath,
    launcher.promptArgName,
    userPrompt,
    "--resume-run-dir",
    previousRunDir,
  ];
  if (resumeSessionId) {
    args.push("--resume-session-id", resumeSessionId);
  }
  if (payload.model) {
    args.push("--model", String(payload.model));
  }
  if (payload.maxTurns) {
    args.push("--max-turns", String(payload.maxTurns));
  }
  if (payload.corpusRoot) {
    args.push("--corpus-root", String(payload.corpusRoot));
  }
  if (payload.alphabookSessionId) {
    args.push("--alphabook-session-id", String(payload.alphabookSessionId));
  }
  if (payload.alphabookRunId) {
    args.push("--alphabook-run-id", String(payload.alphabookRunId));
  }
  if (payload.callbackUrl) {
    args.push("--callback-url", String(payload.callbackUrl));
  }
  if (payload.callbackToken) {
    args.push("--callback-token", String(payload.callbackToken));
  }
  if (payload.archivePrefix) {
    args.push("--archive-prefix", String(payload.archivePrefix));
  }

  return await new Promise((resolve, reject) => {
    const child = spawn(args[0], args.slice(1), {
      cwd: ROOT_DIR,
      env: {
        ...process.env,
        ROOT_DIR,
        RUN_ROOT: launcher.runRoot,
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

async function cancelJob(runDir) {
  const summary = getRunSummary(runDir);
  const pid = Number(summary.pid || 0);
  if (!pid) {
    return { ok: true, cancelled: false, reason: "missing_pid" };
  }
  try {
    process.kill(pid, "SIGTERM");
  } catch {
    return { ok: true, cancelled: false, reason: "not_running" };
  }
  try {
    const statusPath = path.join(runDir, "status.json");
    const current = readJson(statusPath) || {};
    current.state = "cancelled";
    current.cancelled_at = nowIso();
    fs.writeFileSync(statusPath, `${JSON.stringify(current, null, 2)}\n`);
  } catch {}
  return { ok: true, cancelled: true, pid };
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
        runRoots: getWrapperRunRoots(),
        corpusRunRoot: CORPUS_RUN_ROOT,
        searchCorpusRunRoot: SEARCH_CORPUS_RUN_ROOT,
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
      const logPrompt = String(payload.userPrompt || payload.query || "");
      logLine(`job_submitted id=${job.id} type=${job.jobType || "unknown"} prompt_sha=${crypto.createHash("sha1").update(logPrompt).digest("hex").slice(0, 12)}`);
      sendJson(res, 202, { job });
      return;
    }

    if (req.method === "POST" && requestUrl.pathname === "/v1/jobs/resume") {
      const payload = await parseBody(req);
      const job = await resumeJob(payload);
      logLine(`job_resumed id=${job.id} previous=${String(payload.previousJobId || "").trim()} prompt_sha=${crypto.createHash("sha1").update(String(payload.userPrompt)).digest("hex").slice(0, 12)}`);
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
      const mode = requestUrl.searchParams.get("mode") === "all" ? "all" : "curated";
      const logs = await readLogUpdates(runDir, requestUrl.searchParams.get("cursor"), limit, mode);
      sendJson(res, 200, {
        jobId: logMatch[1],
        mode,
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

    const artifactMatch = requestUrl.pathname.match(/^\/v1\/jobs\/([^/]+)\/artifacts\/([^/]+)$/);
    if (req.method === "GET" && artifactMatch) {
      const runDir = resolveRunDir(artifactMatch[1]);
      if (!runDir) {
        sendJson(res, 404, { error: "not_found" });
        return;
      }
      const artifactPath = resolveArtifactPath(runDir, artifactMatch[2]);
      if (!artifactPath) {
        sendJson(res, 404, { error: "not_found" });
        return;
      }
      const stat = statSafe(artifactPath);
      const content = await fsp.readFile(artifactPath, "utf8");
      sendJson(res, 200, {
        jobId: artifactMatch[1],
        artifact: {
          name: normalizeArtifactName(artifactMatch[2]) || path.basename(artifactPath),
          path: artifactPath,
          bytes: stat?.size ?? null,
          updatedAt: stat?.mtime?.toISOString?.() ?? null,
          content,
        },
      });
      return;
    }

    const cancelMatch = requestUrl.pathname.match(/^\/v1\/jobs\/([^/]+)\/cancel$/);
    if (req.method === "POST" && cancelMatch) {
      const runDir = resolveRunDir(cancelMatch[1]);
      if (!runDir) {
        sendJson(res, 404, { error: "not_found" });
        return;
      }
      const result = await cancelJob(runDir);
      sendJson(res, 200, {
        jobId: cancelMatch[1],
        ...result,
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
  logLine(`server_started host=${HOST} port=${PORT} run_roots=${getWrapperRunRoots().join(",")}`);
  console.log(`Hermes job API listening on http://${HOST}:${PORT}`);
});
