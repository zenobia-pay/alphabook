export type HermesJobSummary = {
  id: string;
  jobType?: string | null;
  state: string;
  running: boolean;
  pid: number | null;
  userPrompt: string | null;
  model: string | null;
  maxTurns: number | null;
  launchedAt: string | null;
  startedAt: string | null;
  finishedAt: string | null;
  innerRunDir: string | null;
  innerRunId: string | null;
  hermesSessionId: string | null;
  exitCode: number | null;
  heartbeatAt: string | null;
  phase: string | null;
  phaseProgressPct: number | null;
  detail: string | null;
  manifestStatus: string | null;
  chosenScope: string | null;
  scopeRationale: string | null;
  recordCounts: Record<string, unknown> | null;
  cost?: {
    available?: boolean;
    estimatedCostUsd?: number | null;
    llmCalls?: number | null;
  } | null;
  openai?: Record<string, unknown> | null;
  artifacts?: Array<Record<string, unknown>>;
  archive?: {
    status?: string | null;
    prefix?: string | null;
    manifestKey?: string | null;
    fileCount?: number | null;
    updatedAt?: string | null;
  } | null;
};

type RemoteJobCreatePayload = {
  jobType?: "hermes" | "semantic_search";
  userPrompt?: string;
  query?: string;
  workflow?: "search" | "design_experiment" | "auto";
  effort?: number;
  model?: string;
  maxTurns?: number;
  corpusRoot?: string;
  alphabookSessionId?: string;
  alphabookRunId?: string;
  callbackUrl?: string;
  callbackToken?: string;
  archivePrefix?: string;
  maxResults?: number;
  backend?: "alphaloop" | "context1";
  gutenbergIds?: string[];
};

export type HermesLogSource = {
  name: string;
  path: string;
  bytes: number;
  updatedAt: string;
  lines: string[];
};

export type HermesLogsResponse = {
  jobId: string;
  sources: HermesLogSource[];
  nextCursor: string;
};

export type HermesArtifactResponse = {
  jobId: string;
  artifact: {
    name: string;
    path: string;
    bytes: number | null;
    updatedAt: string | null;
    content: string;
  };
};

export type HermesArtifactListResponse = {
  jobId: string;
  runDir: string;
  innerRunDir: string | null;
  artifacts: Array<Record<string, unknown>>;
};

function buildHeaders(token?: string) {
  return {
    "content-type": "application/json",
    ...(token ? { authorization: `Bearer ${token}` } : {}),
  };
}

async function ensureOk(response: Response) {
  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw new Error(text || `Hermes job API error ${response.status}`);
  }
  return response;
}

export async function createHermesJob(
  baseUrl: string,
  token: string | undefined,
  payload: RemoteJobCreatePayload,
) {
  const response = await ensureOk(await fetch(`${baseUrl.replace(/\/$/, "")}/v1/jobs`, {
    method: "POST",
    headers: buildHeaders(token),
    body: JSON.stringify(payload),
  }));
  return await response.json() as { job: HermesJobSummary };
}

export async function resumeHermesJob(
  baseUrl: string,
  token: string | undefined,
  payload: {
    previousJobId: string;
    hermesSessionId?: string;
    userPrompt: string;
    workflow?: "search" | "design_experiment" | "auto";
    effort?: number;
    model?: string;
    maxTurns?: number;
    corpusRoot?: string;
    alphabookSessionId?: string;
    alphabookRunId?: string;
    callbackUrl?: string;
    callbackToken?: string;
    archivePrefix?: string;
  },
) {
  const response = await ensureOk(await fetch(`${baseUrl.replace(/\/$/, "")}/v1/jobs/resume`, {
    method: "POST",
    headers: buildHeaders(token),
    body: JSON.stringify(payload),
  }));
  return await response.json() as { job: HermesJobSummary };
}

export async function createSemanticSearchJob(
  baseUrl: string,
  token: string | undefined,
  payload: {
    query: string;
    maxResults?: number;
    backend?: "alphaloop" | "context1";
    gutenbergIds?: string[];
    alphabookSessionId?: string;
    alphabookRunId?: string;
    callbackUrl?: string;
    callbackToken?: string;
    archivePrefix?: string;
  },
) {
  return await createHermesJob(baseUrl, token, {
    jobType: "semantic_search",
    query: payload.query,
    maxResults: payload.maxResults,
    backend: payload.backend,
    gutenbergIds: payload.gutenbergIds,
    alphabookSessionId: payload.alphabookSessionId,
    alphabookRunId: payload.alphabookRunId,
    callbackUrl: payload.callbackUrl,
    callbackToken: payload.callbackToken,
    archivePrefix: payload.archivePrefix,
    workflow: "search",
  });
}

export async function fetchHermesJob(
  baseUrl: string,
  token: string | undefined,
  jobId: string,
) {
  const response = await ensureOk(await fetch(`${baseUrl.replace(/\/$/, "")}/v1/jobs/${encodeURIComponent(jobId)}`, {
    headers: buildHeaders(token),
  }));
  return await response.json() as { job: HermesJobSummary };
}

export async function fetchHermesJobLogs(
  baseUrl: string,
  token: string | undefined,
  jobId: string,
  cursor?: string,
  limit = 200,
  mode: "curated" | "all" = "curated",
) {
  const url = new URL(`${baseUrl.replace(/\/$/, "")}/v1/jobs/${encodeURIComponent(jobId)}/logs`);
  url.searchParams.set("limit", String(limit));
  url.searchParams.set("mode", mode);
  if (cursor) {
    url.searchParams.set("cursor", cursor);
  }
  const response = await ensureOk(await fetch(url, {
    headers: buildHeaders(token),
  }));
  return await response.json() as HermesLogsResponse;
}

export async function fetchHermesArtifact(
  baseUrl: string,
  token: string | undefined,
  jobId: string,
  artifactName: string,
) {
  const response = await ensureOk(await fetch(`${baseUrl.replace(/\/$/, "")}/v1/jobs/${encodeURIComponent(jobId)}/artifacts/${encodeURIComponent(artifactName)}`, {
    headers: buildHeaders(token),
  }));
  return await response.json() as HermesArtifactResponse;
}

export async function fetchHermesJobArtifacts(
  baseUrl: string,
  token: string | undefined,
  jobId: string,
) {
  const response = await ensureOk(await fetch(`${baseUrl.replace(/\/$/, "")}/v1/jobs/${encodeURIComponent(jobId)}/artifacts`, {
    headers: buildHeaders(token),
  }));
  return await response.json() as HermesArtifactListResponse;
}

export async function cancelHermesJob(
  baseUrl: string,
  token: string | undefined,
  jobId: string,
) {
  const response = await ensureOk(await fetch(`${baseUrl.replace(/\/$/, "")}/v1/jobs/${encodeURIComponent(jobId)}/cancel`, {
    method: "POST",
    headers: buildHeaders(token),
  }));
  return await response.json() as { jobId: string; ok: boolean; cancelled: boolean };
}
