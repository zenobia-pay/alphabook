import { artifactKeys, HARD_LIMITS, withLegacyWorkAliases, type CorpusWorkspaceDocument } from "@alphabook/corpus-core";
import { ToolArgsSchemas, type WorkSummary } from "@alphabook/shared";
import { gutenbergCorpusAdapter } from "@alphabook/source-gutenberg/adapter";
import { createPlatformRepository } from "./platform-repository";

import type { RuntimeToolGateway } from "./app";
import type { BlobStore } from "./r2";
import type { AppStore, RuntimeInstanceRecord, WorkFileKind, WorkFileRecord } from "./store";

type FetchLike = typeof fetch;

interface ToolExecutionContext {
  sessionId: string;
  runId: string;
}

type RuntimeToolArgs = Record<string, unknown> & Partial<ToolExecutionContext>;

interface WorkspaceDownload {
  r2Key: string;
  destinationPath: string;
  byteSize?: number | null;
  mimeType?: string;
}

interface FlyMachine {
  id: string;
  state?: string;
  instance_id?: string;
}

export interface FlyRuntimeGatewayConfig {
  apiToken: string;
  appName: string;
  image: string;
  region: string;
  databaseUrl?: string;
  runtimeSharedToken?: string;
  runtimeAppUrl?: string;
  codexAuthJson?: string;
  runtimeAgentModel?: string;
  r2BucketName: string;
  r2Endpoint: string;
  r2AccessKeyId: string;
  r2SecretAccessKey: string;
  machineCpuKind?: "shared" | "performance";
  machineCpus?: number;
  machineMemoryMb?: number;
  codexOpenAIBaseUrl?: string;
  codexProxyUpstreamBaseUrl?: string;
}

function nowIso(): string {
  return new Date().toISOString();
}

function addMinutesIso(minutes: number): string {
  return new Date(Date.now() + minutes * 60_000).toISOString();
}

function isExpired(expiresAt: string | null): boolean {
  return Boolean(expiresAt && Date.parse(expiresAt) <= Date.now());
}

function runtimeContainsWorks(instance: RuntimeInstanceRecord, workIds: string[]): boolean {
  const manifestWorks = Array.isArray(instance.manifestJson.works) ? instance.manifestJson.works : [];
  const loadedWorkIds = new Set(
    manifestWorks
      .map((item) => (typeof item === "object" && item && "workId" in item ? String((item as { workId: string }).workId) : null))
      .filter((value): value is string => Boolean(value)),
  );
  return workIds.every((workId) => loadedWorkIds.has(workId));
}

function buildRuntimeAppUrl(appName: string, explicitUrl?: string): string {
  return explicitUrl && explicitUrl.length > 0 ? explicitUrl : `https://${appName}.fly.dev`;
}

function isRetryableRuntimeStartupError(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false;
  }
  const message = error.message.toLowerCase();
  return (
    message.includes("runtime request failed (502)") ||
    message.includes("runtime request failed (503)") ||
    message.includes("runtime request failed (504)") ||
    message.includes("runtime request failed (524)") ||
    message.includes("fetch failed") ||
    message.includes("network connection lost") ||
    message.includes("timed out")
  );
}

function sanitizeMachineName(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 55);
}

function groupWorkFiles(workIds: string[], files: WorkFileRecord[], metadata: WorkSummary[]) {
  return workIds.map((workId): CorpusWorkspaceDocument => {
    const workFiles = files.filter((file) => file.workId === workId);
    const work = metadata.find((candidate) => candidate.id === workId);
    return {
      documentId: workId,
      title: work?.title,
      contributors: work?.authors,
      language: work?.language ?? null,
      publishedAt: work?.releaseDate ?? null,
      rightsStatus: work?.rightsStatus ?? null,
      summary: work?.summary ?? null,
      subjects: work?.subjects,
      cleanTextKey: workFiles.find((file) => file.kind === "clean")?.r2Key,
      chunksKey: workFiles.find((file) => file.kind === "chunks")?.r2Key,
    };
  });
}

function dedupeByKey<T extends { r2Key: string }>(items: T[]): T[] {
  const seen = new Set<string>();
  const deduped: T[] = [];
  for (const item of items) {
    if (seen.has(item.r2Key)) {
      continue;
    }
    seen.add(item.r2Key);
    deduped.push(item);
  }
  return deduped;
}

function uniqueStrings(values: string[]): string[] {
  return Array.from(new Set(values.filter((value) => value.length > 0)));
}

export class StubRuntimeGateway implements RuntimeToolGateway {
  async createWorkspace() {
    return {
      ok: false,
      error: "Runtime sandboxes are not enabled in this environment.",
    };
  }

  async runWorkspaceTask() {
    return {
      ok: false,
      error: "Runtime sandboxes are not enabled in this environment.",
    };
  }

  async cancelWorkspaceTask() {
    return {
      ok: false,
      error: "Runtime sandboxes are not enabled in this environment.",
    };
  }

  async getWorkspaceTaskStatus() {
    return {
      ok: false,
      error: "Runtime sandboxes are not enabled in this environment.",
    };
  }

  async readWorkspaceFile() {
    return {
      ok: false,
      error: "Runtime sandboxes are not enabled in this environment.",
    };
  }

  async listWorkspaceFiles() {
    return {
      ok: false,
      error: "Runtime sandboxes are not enabled in this environment.",
    };
  }

  async destroyWorkspace() {
    return {
      ok: false,
      error: "Runtime sandboxes are not enabled in this environment.",
    };
  }
}

export class HttpRuntimeGateway implements RuntimeToolGateway {
  constructor(
    private readonly baseUrl: string,
    private readonly authToken?: string,
  ) {
    if (!authToken || authToken.trim().length === 0) {
      throw new Error("RUNTIME_SERVICE_TOKEN is required for runtime gateway access.");
    }
  }

  private async request(path: string, init: RequestInit = {}) {
    const url = new URL(path, this.baseUrl).toString();
    const headers = new Headers(init.headers);
    headers.set("content-type", "application/json");
    headers.set("authorization", `Bearer ${this.authToken}`);

    const response = await fetch(url, {
      ...init,
      headers,
      signal: AbortSignal.timeout(HARD_LIMITS.MAX_RUNTIME_TOOL_TIMEOUT_SECONDS * 1000),
    });

    if (!response.ok) {
      const text = await response.text();
      throw new Error(`Runtime request failed (${response.status}): ${text}`);
    }

    return (await response.json()) as Record<string, unknown>;
  }

  async createWorkspace(args: Record<string, unknown>) {
    return this.request("/prepare", {
      method: "POST",
      body: JSON.stringify(args),
    });
  }

  async runWorkspaceTask(args: Record<string, unknown>) {
    return this.request("/run-task", {
      method: "POST",
      body: JSON.stringify(args),
    });
  }

  async cancelWorkspaceTask(args: Record<string, unknown>) {
    return this.request("/cancel-task", {
      method: "POST",
      body: JSON.stringify(args),
    });
  }

  async getWorkspaceTaskStatus() {
    return this.request("/task-status", {
      method: "GET",
    });
  }

  async readWorkspaceFile(args: Record<string, unknown>) {
    const url = new URL("/file", this.baseUrl);
    url.searchParams.set("path", String(args.path ?? ""));
    return this.request(url.pathname + url.search, {
      method: "GET",
    });
  }

  async listWorkspaceFiles() {
    return this.request("/files", {
      method: "GET",
    });
  }

  async destroyWorkspace(args: Record<string, unknown>) {
    return this.request("/destroy", {
      method: "POST",
      body: JSON.stringify(args),
    });
  }
}

export class FlyMachinesRuntimeGateway implements RuntimeToolGateway {
  private readonly apiBaseUrl = "https://api.machines.dev/v1";
  private readonly runtimeAppUrl: string;
  private readonly fetchImpl: FetchLike;

  constructor(
    private readonly store: AppStore,
    private readonly blobStore: BlobStore,
    private readonly config: FlyRuntimeGatewayConfig,
    fetchImpl?: FetchLike,
  ) {
    this.fetchImpl = fetchImpl ?? ((input, init) => fetch(input, init));
    this.runtimeAppUrl = buildRuntimeAppUrl(config.appName, config.runtimeAppUrl);
  }

  async createWorkspace(args: RuntimeToolArgs) {
    const parsed = ToolArgsSchemas.create_workspace.parse(args);
    const sessionId = this.requireSessionId(args);
    await this.destroyExpiredRuntimes(sessionId);

    const reusable = await this.findReusableRuntime(sessionId, parsed.workIds);
    if (reusable) {
      await this.store.updateRuntimeInstance(reusable.runtimeId, {
        status: "ready",
        lastUsedAt: nowIso(),
        expiresAt: addMinutesIso(HARD_LIMITS.MAX_RUNTIME_IDLE_MINUTES),
      });
      return {
        ok: true,
        runtimeId: reusable.runtimeId,
        reused: true,
        manifest: reusable.manifestJson,
      };
    }

    const machine = await this.createMachine(sessionId);
    const runtimeId = machine.id;
    const workspacePlan = await this.buildWorkspacePlan(sessionId, runtimeId, parsed.workIds, parsed.chunkIds, parsed.taskContext);

    await this.store.saveRuntimeInstance({
      sessionId,
      runtimeId,
      provider: "fly-machines",
      providerMachineId: machine.id,
      status: "creating",
      manifestJson: workspacePlan.manifest,
      lastUsedAt: nowIso(),
      expiresAt: addMinutesIso(HARD_LIMITS.MAX_RUNTIME_IDLE_MINUTES),
    });

    try {
      await this.waitForMachine(machine.id, "started");
      await this.waitForRuntimeHttpReady(machine.id);
      await this.prepareWorkspace(machine.id, {
        runtimeId,
        sessionId,
        works: workspacePlan.manifest.works,
        dataSchema: workspacePlan.manifest.dataSchema,
        fileCatalog: workspacePlan.manifest.fileCatalog,
        selectedChunkIds: workspacePlan.manifest.selectedChunkIds,
        selectedChunks: workspacePlan.manifest.selectedChunks,
        taskContext: workspacePlan.manifest.taskContext,
        downloads: workspacePlan.downloads,
      });
      await this.store.updateRuntimeInstance(runtimeId, {
        status: "ready",
        lastUsedAt: nowIso(),
        expiresAt: addMinutesIso(HARD_LIMITS.MAX_RUNTIME_IDLE_MINUTES),
        manifestJson: workspacePlan.manifest,
        providerMachineId: machine.id,
      });
    } catch (error) {
      await this.store.updateRuntimeInstance(runtimeId, {
        status: "failed",
        lastUsedAt: nowIso(),
        expiresAt: addMinutesIso(1),
      });
      throw error;
    }

    return {
      ok: true,
      runtimeId,
      reused: false,
      manifest: workspacePlan.manifest,
      downloads: workspacePlan.downloads.map((download) => ({
        r2Key: download.r2Key,
        destinationPath: download.destinationPath,
      })),
    };
  }

  async runWorkspaceTask(args: RuntimeToolArgs) {
    const parsed = ToolArgsSchemas.run_workspace_task.parse(args);
    const instance = await this.requireRuntime(parsed.runtimeId);
    await this.ensureMachineRunning(instance);
    await this.store.updateRuntimeInstance(parsed.runtimeId, {
      status: "busy",
      lastUsedAt: nowIso(),
      expiresAt: addMinutesIso(HARD_LIMITS.MAX_RUNTIME_IDLE_MINUTES),
    });

    const machineId = instance.providerMachineId ?? parsed.runtimeId;
    await this.callRuntime(machineId, "/run-task", {
      method: "POST",
      body: JSON.stringify({
        runtimeId: parsed.runtimeId,
        taskSpec: parsed.taskSpec,
      }),
    });

    const startedAt = Date.now();
    let result: Record<string, unknown> | null = null;
    while (Date.now() - startedAt < HARD_LIMITS.MAX_RUN_WALL_CLOCK_SECONDS * 1000) {
      const status = await this.callRuntime(machineId, "/task-status", {
        method: "GET",
      });
      if (status.status === "completed" && status.result && typeof status.result === "object") {
        result = status.result as Record<string, unknown>;
        break;
      }
      if (status.status === "failed") {
        await this.persistRuntimeArtifactsFromWorkspace(instance);
        const error = new Error(
          typeof status.error === "string"
            ? status.error
            : "Deep research failed in the runtime.",
        ) as Error & { runtimePayload?: Record<string, unknown> };
        error.runtimePayload = status;
        throw error;
      }
      await new Promise((resolve) => setTimeout(resolve, 750));
    }

    if (!result) {
      await this.persistRuntimeArtifactsFromWorkspace(instance);
      const error = new Error("Deep research timed out before the runtime produced a briefing.") as Error & {
        runtimePayload?: Record<string, unknown>;
      };
      error.runtimePayload = {
        ok: false,
        error: "Deep research timed out before the runtime produced a briefing.",
      };
      throw error;
    }

    const uploadedArtifacts = await this.persistRuntimeArtifacts(instance, result);
    await this.store.updateRuntimeInstance(parsed.runtimeId, {
      status: "ready",
      lastUsedAt: nowIso(),
      expiresAt: addMinutesIso(HARD_LIMITS.MAX_RUNTIME_IDLE_MINUTES),
    });

    return {
      ...result,
      artifacts: uploadedArtifacts,
    };
  }

  async cancelWorkspaceTask(args: RuntimeToolArgs) {
    const runtimeId = typeof args.runtimeId === "string" ? args.runtimeId : "";
    if (!runtimeId) {
      throw new Error("Runtime tool requires a runtimeId.");
    }
    const instance = await this.requireRuntime(runtimeId);
    await this.ensureMachineRunning(instance);
    const machineId = instance.providerMachineId ?? runtimeId;
    const result = await this.callRuntime(machineId, "/cancel-task", {
      method: "POST",
      body: JSON.stringify({ runtimeId }),
    });
    await this.store.updateRuntimeInstance(runtimeId, {
      status: "ready",
      lastUsedAt: nowIso(),
      expiresAt: addMinutesIso(HARD_LIMITS.MAX_RUNTIME_IDLE_MINUTES),
    });
    return result;
  }

  async getWorkspaceTaskStatus(args: RuntimeToolArgs) {
    const runtimeId = typeof args.runtimeId === "string" ? args.runtimeId : "";
    if (!runtimeId) {
      throw new Error("Runtime tool requires a runtimeId.");
    }
    const instance = await this.requireRuntime(runtimeId);
    await this.ensureMachineRunning(instance);
    const machineId = instance.providerMachineId ?? runtimeId;
    const status = await this.callRuntime(machineId, "/task-status", {
      method: "GET",
    });

    if (status.status === "completed" && status.result && typeof status.result === "object") {
      const result = status.result as Record<string, unknown>;
      const uploadedArtifacts = await this.persistRuntimeArtifacts(instance, result);
      await this.store.updateRuntimeInstance(runtimeId, {
        status: "ready",
        lastUsedAt: nowIso(),
        expiresAt: addMinutesIso(HARD_LIMITS.MAX_RUNTIME_IDLE_MINUTES),
      });
      return {
        ...status,
        result: {
          ...result,
          artifacts: uploadedArtifacts,
        },
      };
    }

    if (status.status === "failed") {
      await this.persistRuntimeArtifactsFromWorkspace(instance);
      await this.store.updateRuntimeInstance(runtimeId, {
        status: "failed",
        lastUsedAt: nowIso(),
        expiresAt: addMinutesIso(1),
      });
      return status;
    }

    await this.store.updateRuntimeInstance(runtimeId, {
      status: "busy",
      lastUsedAt: nowIso(),
      expiresAt: addMinutesIso(HARD_LIMITS.MAX_RUNTIME_IDLE_MINUTES),
    });
    return status;
  }

  async readWorkspaceFile(args: RuntimeToolArgs) {
    const parsed = ToolArgsSchemas.read_workspace_file.parse(args);
    const instance = await this.requireRuntime(parsed.runtimeId);
    await this.ensureMachineRunning(instance);
    const machineId = instance.providerMachineId ?? parsed.runtimeId;
    const result = await this.callRuntime(
      machineId,
      `/file?path=${encodeURIComponent(parsed.path)}`,
      { method: "GET" },
    );
    await this.store.updateRuntimeInstance(parsed.runtimeId, {
      status: "ready",
      lastUsedAt: nowIso(),
      expiresAt: addMinutesIso(HARD_LIMITS.MAX_RUNTIME_IDLE_MINUTES),
    });
    return result;
  }

  async listWorkspaceFiles(args: RuntimeToolArgs) {
    const runtimeId = typeof args.runtimeId === "string" ? args.runtimeId : "";
    if (!runtimeId) {
      throw new Error("Runtime tool requires a runtimeId.");
    }
    const instance = await this.requireRuntime(runtimeId);
    await this.ensureMachineRunning(instance);
    const machineId = instance.providerMachineId ?? runtimeId;
    const result = await this.callRuntime(machineId, "/files", { method: "GET" });
    await this.store.updateRuntimeInstance(runtimeId, {
      status: "ready",
      lastUsedAt: nowIso(),
      expiresAt: addMinutesIso(HARD_LIMITS.MAX_RUNTIME_IDLE_MINUTES),
    });
    return result;
  }

  async destroyWorkspace(args: RuntimeToolArgs) {
    const parsed = ToolArgsSchemas.destroy_workspace.parse(args);
    const instance = await this.store.getRuntimeInstance(parsed.runtimeId);
    if (!instance) {
      return {
        ok: true,
        runtimeId: parsed.runtimeId,
        destroyed: false,
        missing: true,
      };
    }

    try {
      await this.callRuntime(instance.providerMachineId ?? parsed.runtimeId, "/destroy", {
        method: "POST",
        body: JSON.stringify({
          runtimeId: parsed.runtimeId,
        }),
      });
    } catch {
      // Best effort cleanup; deleting the Machine is the stronger guarantee.
    }

    await this.deleteMachine(instance.providerMachineId ?? parsed.runtimeId);
    await this.store.updateRuntimeInstance(parsed.runtimeId, {
      status: "destroyed",
      lastUsedAt: nowIso(),
      expiresAt: nowIso(),
    });

    return {
      ok: true,
      runtimeId: parsed.runtimeId,
      destroyed: true,
    };
  }

  private requireSessionId(args: RuntimeToolArgs): string {
    const sessionId = args.sessionId;
    if (typeof sessionId !== "string" || sessionId.length === 0) {
      throw new Error("Runtime tool requires a sessionId.");
    }
    return sessionId;
  }

  private async flyRequest(path: string, init: RequestInit = {}) {
    const headers = new Headers(init.headers);
    headers.set("authorization", `Bearer ${this.config.apiToken}`);
    if (init.body && !headers.has("content-type")) {
      headers.set("content-type", "application/json");
    }

    const response = await this.fetchImpl(`${this.apiBaseUrl}${path}`, {
      ...init,
      headers,
      signal: AbortSignal.timeout(HARD_LIMITS.MAX_RUNTIME_TOOL_TIMEOUT_SECONDS * 1000),
    });

    if (!response.ok) {
      const text = await response.text();
      throw new Error(`Fly API request failed (${response.status}): ${text}`);
    }

    return response;
  }

  private async callRuntime(
    machineId: string,
    path: string,
    init: RequestInit,
    options: { timeoutMs?: number } = {},
  ) {
    const headers = new Headers(init.headers);
    if (init.body && !headers.has("content-type")) {
      headers.set("content-type", "application/json");
    }
    headers.set("fly-force-instance-id", machineId);
    if (this.config.runtimeSharedToken) {
      headers.set("authorization", `Bearer ${this.config.runtimeSharedToken}`);
    }

    const response = await this.fetchImpl(new URL(path, this.runtimeAppUrl).toString(), {
      ...init,
      headers,
      signal: AbortSignal.timeout(options.timeoutMs ?? HARD_LIMITS.MAX_RUNTIME_TOOL_TIMEOUT_SECONDS * 1000),
    });
    if (!response.ok) {
      const contentType = response.headers.get("content-type") ?? "";
      if (contentType.includes("application/json")) {
        const payload = await response.json() as Record<string, unknown>;
        const error = new Error(
          `Runtime request failed (${response.status}): ${typeof payload.error === "string" ? payload.error : JSON.stringify(payload)}`,
        ) as Error & { runtimePayload?: Record<string, unknown> };
        error.runtimePayload = payload;
        throw error;
      }
      const text = await response.text();
      throw new Error(`Runtime request failed (${response.status}): ${text}`);
    }
    return (await response.json()) as Record<string, unknown>;
  }

  private async waitForRuntimeHttpReady(machineId: string): Promise<void> {
    const startedAt = Date.now();
    const maxWaitMs = 45_000;
    let lastError: unknown = null;

    while (Date.now() - startedAt < maxWaitMs) {
      try {
        await this.callRuntime(machineId, "/health", { method: "GET" }, { timeoutMs: 3_500 });
        return;
      } catch (error) {
        lastError = error;
        await new Promise((resolve) => setTimeout(resolve, 750));
      }
    }

    if (lastError instanceof Error) {
      throw new Error(`Runtime became reachable too slowly: ${lastError.message}`);
    }
    throw new Error("Runtime became reachable too slowly.");
  }

  private async prepareWorkspace(machineId: string, payload: Record<string, unknown>) {
    let lastError: unknown = null;
    for (let attempt = 1; attempt <= 2; attempt += 1) {
      try {
        return await this.callRuntime(machineId, "/prepare", {
          method: "POST",
          body: JSON.stringify(payload),
        }, { timeoutMs: 12_000 });
      } catch (error) {
        lastError = error;
        if (attempt >= 2 || !isRetryableRuntimeStartupError(error)) {
          throw error;
        }
        await new Promise((resolve) => setTimeout(resolve, attempt * 1_000));
      }
    }
    throw lastError instanceof Error ? lastError : new Error("Workspace preparation failed.");
  }

  private async createMachine(sessionId: string): Promise<FlyMachine> {
    const name = sanitizeMachineName(`alphabook-${sessionId.slice(0, 8)}-${crypto.randomUUID().slice(0, 8)}`);
    const response = await this.flyRequest(`/apps/${this.config.appName}/machines`, {
      method: "POST",
      body: JSON.stringify({
        name,
        region: this.config.region,
        skip_launch: false,
        config: {
          image: this.config.image,
          env: {
            PORT: "8080",
            RUNTIME_WORKSPACE_ROOT: "/workspace",
            RUNTIME_SHARED_TOKEN: this.config.runtimeSharedToken ?? "",
            RUNTIME_AGENT_COMMAND: "/app/apps/runtime/bin/run-agent.mjs",
            DATABASE_URL: this.config.databaseUrl ?? "",
            CODEX_AUTH_JSON: this.config.codexAuthJson ?? "",
            RUNTIME_AGENT_MODEL: this.config.runtimeAgentModel ?? "gpt-5-codex",
            R2_BUCKET_NAME: this.config.r2BucketName,
            R2_ENDPOINT: this.config.r2Endpoint,
            R2_ACCESS_KEY_ID: this.config.r2AccessKeyId,
            R2_SECRET_ACCESS_KEY: this.config.r2SecretAccessKey,
          },
          guest: {
            cpu_kind: this.config.machineCpuKind ?? "shared",
            cpus: this.config.machineCpus ?? 1,
            memory_mb: this.config.machineMemoryMb ?? 1024,
          },
          restart: {
            policy: "no",
          },
          metadata: {
            "alphabook.session_id": sessionId,
            "alphabook.runtime": "true",
          },
          services: [
            {
              protocol: "tcp",
              internal_port: 8080,
              ports: [
                {
                  port: 80,
                  handlers: ["http"],
                },
                {
                  port: 443,
                  handlers: ["tls", "http"],
                },
              ],
            },
          ],
          checks: {
            runtime: {
              type: "http",
              port: 8080,
              interval: "15s",
              timeout: "10s",
              grace_period: "30s",
              method: "get",
              path: "/health",
            },
          },
        },
      }),
    });
    return (await response.json()) as FlyMachine;
  }

  private async getMachine(machineId: string): Promise<FlyMachine> {
    const response = await this.flyRequest(`/apps/${this.config.appName}/machines/${machineId}`, {
      method: "GET",
    });
    return (await response.json()) as FlyMachine;
  }

  private async waitForMachine(machineId: string, state = "started"): Promise<void> {
    const waitTimeoutSeconds = Math.min(HARD_LIMITS.MAX_RUNTIME_TOOL_TIMEOUT_SECONDS, 60);
    await this.flyRequest(
      `/apps/${this.config.appName}/machines/${machineId}/wait?state=${encodeURIComponent(state)}&timeout=${waitTimeoutSeconds}`,
      { method: "GET" },
    );
  }

  private async startMachine(machineId: string): Promise<void> {
    await this.flyRequest(`/apps/${this.config.appName}/machines/${machineId}/start`, {
      method: "POST",
    });
  }

  private async deleteMachine(machineId: string): Promise<void> {
    await this.flyRequest(`/apps/${this.config.appName}/machines/${machineId}?force=true`, {
      method: "DELETE",
    });
  }

  private async ensureMachineRunning(instance: RuntimeInstanceRecord): Promise<void> {
    const machine = await this.getMachine(instance.providerMachineId ?? instance.runtimeId);
    if (machine.state !== "started") {
      await this.startMachine(instance.providerMachineId ?? instance.runtimeId);
      await this.waitForMachine(instance.providerMachineId ?? instance.runtimeId, "started");
    }
  }

  private async findReusableRuntime(sessionId: string, workIds: string[]): Promise<RuntimeInstanceRecord | null> {
    const runtimes = await this.store.listRuntimeInstances(sessionId);
    return (
      runtimes.find(
        (instance) =>
          instance.status !== "destroyed" &&
          instance.status !== "failed" &&
          !isExpired(instance.expiresAt) &&
          runtimeContainsWorks(instance, workIds),
      ) ?? null
    );
  }

  private async destroyExpiredRuntimes(sessionId: string): Promise<void> {
    const runtimes = await this.store.listRuntimeInstances(sessionId);
    for (const runtime of runtimes) {
      if (runtime.status === "destroyed" || runtime.status === "expired" || !isExpired(runtime.expiresAt)) {
        continue;
      }
      try {
        await this.deleteMachine(runtime.providerMachineId ?? runtime.runtimeId);
      } catch {
        // Ignore deletion failures during opportunistic cleanup.
      }
      await this.store.updateRuntimeInstance(runtime.runtimeId, {
        status: "expired",
        lastUsedAt: nowIso(),
        expiresAt: nowIso(),
      });
    }
  }

  private async buildWorkspacePlan(
    sessionId: string,
    runtimeId: string,
    workIds: string[],
    chunkIds: string[],
    taskContext: Record<string, unknown>,
  ) {
    const repository = createPlatformRepository(this.store);
    const resolvedWorkIds = uniqueStrings(workIds);
    const [documents, documentFiles, selectedChunks, corpusDocumentCount] = await Promise.all([
      repository.getDocumentMetadata(resolvedWorkIds),
      repository.getDocumentFiles(resolvedWorkIds, ["clean", "chunks"]),
      chunkIds.length > 0 ? repository.getChunksByIds(chunkIds) : Promise.resolve([]),
      repository.countDocuments(),
    ]);
    let totalBytes = 0;
    const workMetadata = documents.map((document) => ({
      id: document.id,
      title: document.title,
      authors: document.contributors ?? [],
      language: document.language ?? null,
      releaseDate: document.publishedAt ?? null,
      rightsStatus: document.rightsStatus ?? null,
      summary: document.summary ?? null,
      subjects: document.subjects ?? [],
    })) as WorkSummary[];
    const workFiles = documentFiles.map((file) => ({
      id: `${file.documentId}:${file.kind}:${file.r2Key}`,
      workId: file.documentId,
      kind: file.kind as WorkFileKind,
      r2Key: file.r2Key,
      byteSize: file.byteSize ?? null,
      metadata: file.metadata ?? {},
    }));
    const fileCatalog = dedupeByKey(workFiles).map((file) => ({
      documentId: file.workId,
      kind: file.kind,
      r2Key: file.r2Key,
      destinationPath:
        file.kind === "clean"
          ? `books/${file.workId}/clean.txt`
          : `chunks/${file.workId}/chunks.jsonl`,
      byteSize: file.byteSize ?? null,
    }));

    const { hydratedWorkIds: _ignoredHydratedWorkIds, ...restTaskContext } = taskContext;

    const manifest = withLegacyWorkAliases({
      runtimeId,
      sessionId,
      documents: groupWorkFiles(resolvedWorkIds, workFiles, workMetadata),
      dataSchema: gutenbergCorpusAdapter.workspaceSchema,
      fileCatalog,
      selectedChunkIds: chunkIds,
      selectedChunks: selectedChunks.map((chunk) => ({
        id: chunk.id,
        documentId: chunk.documentId,
        chunkIndex: chunk.chunkIndex,
        text: chunk.text,
        excerpt: chunk.excerpt,
        r2Key: chunk.r2Key ?? null,
      })),
      taskContext: {
        ...restTaskContext,
        corpusWorkCount: corpusDocumentCount,
        hydratedWorkCount: resolvedWorkIds.length,
      },
    });

    const manifestKey = artifactKeys.runtimeArtifact(runtimeId, "manifest.json");
    const manifestText = JSON.stringify(manifest, null, 2);
    totalBytes += manifestText.length;
    await this.blobStore.putJson(manifestKey, manifest);
    await this.store.saveArtifact({
      sessionId,
      runtimeId,
      r2Key: manifestKey,
      filename: "manifest.json",
      mimeType: "application/json",
      metadata: {
        kind: "manifest",
      },
    });

    if (selectedChunks.length > 0) {
      const selectedChunksKey = artifactKeys.runtimeArtifact(runtimeId, "selected-chunks.json");
      const selectedChunksText = JSON.stringify(selectedChunks, null, 2);
      totalBytes += selectedChunksText.length;
      await this.blobStore.putJson(selectedChunksKey, selectedChunks);
      await this.store.saveArtifact({
        sessionId,
        runtimeId,
        r2Key: selectedChunksKey,
        filename: "selected-chunks.json",
        mimeType: "application/json",
        metadata: {
          kind: "selected_chunks",
          chunkIds,
        },
      });
    }

    if (totalBytes > HARD_LIMITS.MAX_WORKSPACE_BYTES) {
      throw new Error(`Workspace hydration would exceed ${HARD_LIMITS.MAX_WORKSPACE_BYTES} bytes.`);
    }

    return {
      manifest,
      downloads: [] as WorkspaceDownload[],
      totalBytes,
    };
  }

  private async persistRuntimeArtifacts(instance: RuntimeInstanceRecord, result: Record<string, unknown>) {
    const artifacts = Array.isArray(result.artifacts)
      ? (result.artifacts as Array<Record<string, unknown>>)
      : [];
    const existingArtifacts = await this.store.listArtifacts(instance.sessionId, instance.runtimeId);
    const existingByFilename = new Map(existingArtifacts.map((artifact) => [artifact.filename, artifact]));
    const uploaded = [];

    for (const artifact of artifacts) {
      const path = typeof artifact.path === "string" ? artifact.path : null;
      const filename = typeof artifact.filename === "string" ? artifact.filename : null;
      const mimeType = typeof artifact.mimeType === "string" ? artifact.mimeType : "application/octet-stream";
      const metadata = artifact.metadata && typeof artifact.metadata === "object"
        ? artifact.metadata as Record<string, unknown>
        : {};
      if (!path || !filename) {
        continue;
      }
      const existing = existingByFilename.get(filename);
      if (existing) {
        uploaded.push({
          filename,
          path,
          mimeType: existing.mimeType,
          r2Key: existing.r2Key,
        });
        continue;
      }

      const fileResponse = await this.callRuntime(
        instance.providerMachineId ?? instance.runtimeId,
        `/file?path=${encodeURIComponent(path)}`,
        { method: "GET" },
      );
      const content = typeof fileResponse.content === "string" ? fileResponse.content : "";
      const r2Key = artifactKeys.runtimeArtifact(instance.runtimeId, filename);
      await this.blobStore.putText(r2Key, content, mimeType);
      await this.store.saveArtifact({
        sessionId: instance.sessionId,
        runtimeId: instance.runtimeId,
        r2Key,
        filename,
        mimeType,
        metadata: {
          path,
          source: "runtime-output",
          ...metadata,
        },
      });
      uploaded.push({
        filename,
        path,
        mimeType,
        r2Key,
      });
    }

    return uploaded;
  }

  private async persistRuntimeArtifactsFromWorkspace(instance: RuntimeInstanceRecord) {
    const machineId = instance.providerMachineId ?? instance.runtimeId;
    const listed = await this.callRuntime(machineId, "/files", { method: "GET" }).catch(() => null);
    const files = Array.isArray(listed?.files)
      ? (listed.files as unknown[]).filter((value): value is string => typeof value === "string")
      : [];
    if (files.length === 0) {
      return [];
    }
    return this.persistRuntimeArtifacts(instance, {
      artifacts: files.map((path) => ({
        path,
        filename: path.split("/").at(-1) ?? path,
        mimeType: path.endsWith(".md")
          ? "text/markdown"
          : path.endsWith(".json") || path.endsWith(".jsonl")
            ? "application/json"
            : "application/octet-stream",
      })),
    });
  }

  private async requireRuntime(runtimeId: string): Promise<RuntimeInstanceRecord> {
    const instance = await this.store.getRuntimeInstance(runtimeId);
    if (!instance) {
      throw new Error(`Runtime ${runtimeId} was not found.`);
    }
    if (instance.status === "destroyed" || instance.status === "expired") {
      throw new Error(`Runtime ${runtimeId} is no longer available.`);
    }
    return instance;
  }
}
