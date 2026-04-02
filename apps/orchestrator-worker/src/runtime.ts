import { artifactKeys, HARD_LIMITS, withLegacyWorkAliases, type CorpusWorkspaceDocument } from "@alphabook/corpus-core";
import { defaultCorpusAdapter, ToolArgsSchemas, type WorkSummary } from "@alphabook/shared";
import { createPlatformRepository } from "./platform-repository";
import {
  SpriteFanoutCoordinator,
  buildSpriteWorkspacePlan,
  estimateSpritePrepareTimeoutMs,
  type SpriteShardManifest,
} from "./sprite-fanout";
export { estimateSpritePrepareTimeoutMs } from "./sprite-fanout";

import type { RuntimeToolGateway } from "./app";
import type { BlobStore } from "./r2";
import type { AppStore, DocumentFileKind, DocumentFileRecord, RuntimeInstanceRecord } from "./store";

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
  kind?: "clean" | "chunks";
}

interface FlyMachine {
  id: string;
  state?: string;
  instance_id?: string;
  name?: string;
  created_at?: string;
  updated_at?: string;
  config?: {
    metadata?: Record<string, string>;
  } | null;
  incomplete_config?: {
    metadata?: Record<string, string>;
  } | null;
}

interface FlyMachineGuestConfig {
  cpu_kind: "shared" | "performance";
  cpus: number;
  memory_mb: number;
}

type ProvisionSpriteShardArgs = {
  sessionId: string;
  implementationId: string;
  shard: SpriteShardManifest;
  expiresMinutes?: number;
};

const DEFAULT_RUNTIME_AGENT_MODEL = "gpt-5.4";
const RUNTIME_STATUS_POLL_TIMEOUT_MS = 5_000;
const DEFAULT_SPRITE_SHARD_GUEST: FlyMachineGuestConfig = {
  cpu_kind: "performance",
  cpus: 4,
  memory_mb: 8192,
};
const DEFAULT_SPRITE_AGGREGATOR_GUEST: FlyMachineGuestConfig = {
  cpu_kind: "shared",
  cpus: 2,
  memory_mb: 4096,
};
const STALE_SPRITE_MACHINE_THRESHOLD_MS = 20 * 60_000;
const SPRITE_MACHINE_NAME_PREFIXES = ["alphabook-sprite-", "alphabook-aggregate-"] as const;

function flyMachineMetadata(machine: FlyMachine): Record<string, string> {
  return machine.config?.metadata ?? machine.incomplete_config?.metadata ?? {};
}

function isSpriteRuntimeMachine(machine: FlyMachine): boolean {
  const metadata = flyMachineMetadata(machine);
  const runtimeMode = metadata["alphabook.runtime_mode"];
  if (runtimeMode === "sprite-shard" || runtimeMode === "sprite-aggregate") {
    return true;
  }
  const name = machine.name ?? "";
  return SPRITE_MACHINE_NAME_PREFIXES.some((prefix) => name.startsWith(prefix));
}

function isMachineForSession(machine: FlyMachine, sessionId: string): boolean {
  if (!sessionId) {
    return false;
  }
  const metadata = flyMachineMetadata(machine);
  if (metadata["alphabook.session_id"] === sessionId) {
    return true;
  }
  const name = machine.name ?? "";
  return name.includes(sessionId.slice(0, 8));
}

function machineUpdatedAtMs(machine: FlyMachine): number | null {
  const value = machine.updated_at ?? machine.created_at;
  if (!value) {
    return null;
  }
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function artifactMimeTypeForPath(path: string): string {
  if (path.endsWith(".md")) {
    return "text/markdown";
  }
  if (path.endsWith(".txt") || path.endsWith(".log")) {
    return "text/plain";
  }
  if (path.endsWith(".json") || path.endsWith(".jsonl")) {
    return "application/json";
  }
  return "application/octet-stream";
}

export function isStaleSpriteMachine(machine: FlyMachine, sessionId: string, nowMs = Date.now()): boolean {
  if (!isSpriteRuntimeMachine(machine) || isMachineForSession(machine, sessionId)) {
    return false;
  }
  const updatedAtMs = machineUpdatedAtMs(machine);
  if (updatedAtMs === null) {
    return false;
  }
  return nowMs - updatedAtMs >= STALE_SPRITE_MACHINE_THRESHOLD_MS;
}

export function spriteGuestConfig(
  kind: "shard" | "aggregate",
  config: Pick<FlyRuntimeGatewayConfig, "machineCpuKind" | "machineCpus" | "machineMemoryMb">,
): FlyMachineGuestConfig {
  const fallback = kind === "shard" ? DEFAULT_SPRITE_SHARD_GUEST : DEFAULT_SPRITE_AGGREGATOR_GUEST;
  return {
    cpu_kind:
      config.machineCpuKind === "performance" || fallback.cpu_kind === "performance"
        ? "performance"
        : "shared",
    cpus: Math.max(fallback.cpus, config.machineCpus ?? 0),
    memory_mb: Math.max(fallback.memory_mb, config.machineMemoryMb ?? 0),
  };
}

export interface FlyRuntimeGatewayConfig {
  apiToken: string;
  appName: string;
  image: string;
  region: string;
  openAIApiKey?: string;
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
  workspaceDownloadBaseUrl?: string;
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

function isIgnorableMachineCleanupError(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false;
  }
  const message = error.message.toLowerCase();
  return (
    message.includes("unable to start machine from current state: 'destroyed'") ||
    message.includes("machine not found") ||
    message.includes("instance not found")
  );
}

function sanitizeMachineName(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 55);
}

function groupDocumentFiles(documentIds: string[], files: DocumentFileRecord[], metadata: WorkSummary[]) {
  return documentIds.map((documentId): CorpusWorkspaceDocument => {
    const documentFiles = files.filter((file) => file.documentId === documentId);
    const work = metadata.find((candidate) => candidate.id === documentId);
    return {
      documentId,
      title: work?.title,
      contributors: work?.authors,
      language: work?.language ?? null,
      publishedAt: work?.releaseDate ?? null,
      rightsStatus: work?.rightsStatus ?? null,
      summary: work?.summary ?? null,
      subjects: work?.subjects,
      cleanTextKey: documentFiles.find((file) => file.kind === "clean")?.r2Key,
      chunksKey: documentFiles.find((file) => file.kind === "chunks")?.r2Key,
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

function normalizeRuntimeProgressEvent(event: Record<string, unknown>) {
  const message = typeof event.message === "string"
    ? event.message.trim()
    : typeof event.note === "string"
      ? event.note.trim()
      : "";
  if (message) {
    return message;
  }
  const type = typeof event.type === "string" ? event.type : "runtime.progress";
  return type.replace(/[._-]+/g, " ").trim() || "Runtime progress updated.";
}

function uniqueArtifactEntries(
  artifacts: Array<Record<string, unknown>>,
): Array<Record<string, unknown>> {
  const seen = new Set<string>();
  const deduped: Array<Record<string, unknown>> = [];
  for (const artifact of artifacts) {
    const r2Key = typeof artifact.r2Key === "string" ? artifact.r2Key : "";
    const filename = typeof artifact.filename === "string" ? artifact.filename : "";
    const path = typeof artifact.path === "string" ? artifact.path : "";
    const key = `${r2Key}::${filename}::${path}`;
    if (!key || seen.has(key)) {
      continue;
    }
    seen.add(key);
    deduped.push(artifact);
  }
  return deduped;
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

  async runSpriteFanoutResearch() {
    return {
      ok: false,
      error: "Sprite fanout research is not enabled in this environment.",
    };
  }

  async cleanupStaleSpriteMachines() {
    return 0;
  }

  async listSpriteSessionMachines() {
    return [];
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

  async cleanupStaleSpriteMachines() {
    return 0;
  }

  async listSpriteSessionMachines() {
    return [];
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

  async runSpriteFanoutResearch() {
    return {
      ok: false,
      error: "Sprite fanout research requires Fly runtime access.",
    };
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
    const progressReporter =
      typeof (args as { __progressReporter?: unknown }).__progressReporter === "function"
        ? (args as { __progressReporter?: (text: string, detail?: Record<string, unknown>) => Promise<void> }).__progressReporter
        : undefined;
    return this.executeRuntimeTask(instance, parsed.taskSpec, {
      onProgress: progressReporter,
    });
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
      const streamArtifacts = await this.persistRuntimeResultStreams(instance, result);
      const workspaceArtifacts = await this.persistRuntimeArtifactsFromWorkspace(instance).catch(() => []);
      await this.store.updateRuntimeInstance(runtimeId, {
        status: "ready",
        lastUsedAt: nowIso(),
        expiresAt: addMinutesIso(HARD_LIMITS.MAX_RUNTIME_IDLE_MINUTES),
      });
      return {
        ...status,
        result: {
          ...result,
          artifacts: uniqueArtifactEntries([
            ...uploadedArtifacts,
            ...streamArtifacts,
            ...workspaceArtifacts,
          ]),
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
      }, { timeoutMs: 5_000 });
    } catch {
      // Best effort cleanup; deleting the Machine is the stronger guarantee.
    }

    try {
      await this.deleteMachine(instance.providerMachineId ?? parsed.runtimeId);
    } catch (error) {
      if (!isIgnorableMachineCleanupError(error)) {
        throw error;
      }
    }
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

  async runSpriteFanoutResearch(args: RuntimeToolArgs) {
    const coordinator = new SpriteFanoutCoordinator({
      store: this.store,
      blobStore: this.blobStore,
      cleanupStaleSpriteMachines: (sessionId) => this.cleanupStaleSpriteMachines(sessionId),
      createMachineWithMetadata: (sessionId, options) => this.createMachineWithMetadata(sessionId, options),
      waitForMachine: (machineId, state) => this.waitForMachine(machineId, state),
      waitForRuntimeHttpReady: (machineId) => this.waitForRuntimeHttpReady(machineId),
      requireRuntime: (runtimeId) => this.requireRuntime(runtimeId),
      buildWorkspacePlan: (sessionId, runtimeId, workIds, chunkIds, taskContext) =>
        this.buildWorkspacePlan(sessionId, runtimeId, workIds, chunkIds, taskContext),
      prepareWorkspace: (machineId, payload, options) => this.prepareWorkspace(machineId, payload, options),
      executeRuntimeTask: (instance, taskSpec, options) => this.executeRuntimeTask(instance, taskSpec, options),
      destroyWorkspace: (payload) => this.destroyWorkspace(payload),
      deleteMachine: (machineId) => this.deleteMachine(machineId),
      callRuntime: (machineId, path, init) => this.callRuntime(machineId, path, init),
      spriteGuestConfig: (kind) => spriteGuestConfig(kind, this.config),
    });
    return coordinator.run(args);
  }

  async provisionSpriteShard(args: ProvisionSpriteShardArgs) {
    const expiresMinutes = Number.isFinite(args.expiresMinutes) && (args.expiresMinutes ?? 0) > 0
      ? Math.floor(args.expiresMinutes!)
      : HARD_LIMITS.MAX_RUNTIME_IDLE_MINUTES;
    const { shard } = args;
    let machineId: string | null = null;
    let runtimeId: string | null = null;

    try {
      const machine = await this.createMachineWithMetadata(args.sessionId, {
        namePrefix: "alphabook-sprite",
        metadata: {
          "alphabook.runtime_mode": "sprite-shard",
          "alphabook.shard_id": shard.shardId,
          "alphabook.implementation_id": args.implementationId,
        },
        guest: spriteGuestConfig("shard", this.config),
      });
      machineId = machine.id;
      runtimeId = machine.id;

      const workspacePlan = await buildSpriteWorkspacePlan(
        this.store,
        this.blobStore,
        args.sessionId,
        runtimeId,
        shard.workIds,
        {
          researchMode: "sprite_fanout",
          spriteShard: {
            implementationId: args.implementationId,
            shardId: shard.shardId,
            index: shard.index,
            totalShards: shard.totalShards,
            bookCount: shard.bookCount,
            totalTextBytes: shard.totalTextBytes,
            lifecycleState: "hydrating",
            lastLifecycleAt: nowIso(),
          },
        },
      );

      await this.store.saveRuntimeInstance({
        sessionId: args.sessionId,
        runtimeId,
        provider: "fly-sprites",
        providerMachineId: machine.id,
        status: "creating",
        manifestJson: workspacePlan.manifest,
        lastUsedAt: nowIso(),
        expiresAt: addMinutesIso(expiresMinutes),
      });

      await this.waitForMachine(machine.id, "started");
      await this.waitForRuntimeHttpReady(machine.id);
      await this.prepareWorkspace(machine.id, {
        runtimeId,
        sessionId: args.sessionId,
        works: workspacePlan.manifest.works,
        dataSchema: workspacePlan.manifest.dataSchema,
        fileCatalog: workspacePlan.manifest.fileCatalog,
        selectedChunkIds: [],
        selectedChunks: [],
        taskContext: workspacePlan.manifest.taskContext,
        downloads: workspacePlan.downloads,
      }, {
        timeoutMs: estimateSpritePrepareTimeoutMs(shard),
      });

      const readyManifest = {
        ...workspacePlan.manifest,
        taskContext: {
          ...(workspacePlan.manifest.taskContext && typeof workspacePlan.manifest.taskContext === "object"
            ? workspacePlan.manifest.taskContext
            : {}),
          researchMode: "sprite_fanout",
          spriteShard: {
            implementationId: args.implementationId,
            shardId: shard.shardId,
            index: shard.index,
            totalShards: shard.totalShards,
            bookCount: shard.bookCount,
            totalTextBytes: shard.totalTextBytes,
            lifecycleState: "ready",
            lastLifecycleAt: nowIso(),
          },
        },
      };

      await this.store.updateRuntimeInstance(runtimeId, {
        status: "ready",
        manifestJson: readyManifest,
        lastUsedAt: nowIso(),
        expiresAt: addMinutesIso(expiresMinutes),
        providerMachineId: machine.id,
      });

      return {
        ok: true,
        sessionId: args.sessionId,
        runtimeId,
        machineId: machine.id,
        shardId: shard.shardId,
        shardIndex: shard.index,
        totalShards: shard.totalShards,
        bookCount: shard.bookCount,
      };
    } catch (error) {
      if (runtimeId) {
        await this.store.updateRuntimeInstance(runtimeId, {
          status: "failed",
          lastUsedAt: nowIso(),
          expiresAt: nowIso(),
          ...(machineId ? { providerMachineId: machineId } : {}),
        }).catch(() => {});
      }
      if (machineId) {
        await this.deleteMachine(machineId).catch(() => {});
      }
      throw error;
    }
  }

  private requireSessionId(args: RuntimeToolArgs): string {
    const sessionId = args.sessionId;
    if (typeof sessionId !== "string" || sessionId.length === 0) {
      throw new Error("Runtime tool requires a sessionId.");
    }
    return sessionId;
  }

  private async flyRequest(path: string, init: RequestInit = {}, options: { timeoutMs?: number } = {}) {
    const headers = new Headers(init.headers);
    headers.set("authorization", `Bearer ${this.config.apiToken}`);
    if (init.body && !headers.has("content-type")) {
      headers.set("content-type", "application/json");
    }

    const response = await this.fetchImpl(`${this.apiBaseUrl}${path}`, {
      ...init,
      headers,
      signal: AbortSignal.timeout(options.timeoutMs ?? HARD_LIMITS.MAX_RUNTIME_TOOL_TIMEOUT_SECONDS * 1000),
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
    const maxWaitMs = 90_000;
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

  private async prepareWorkspace(
    machineId: string,
    payload: Record<string, unknown>,
    options: { timeoutMs?: number } = {},
  ) {
    const normalizedDownloads = Array.isArray(payload.downloads)
      ? (payload.downloads as Array<Record<string, unknown>>).map((download) => {
        const mapped: Record<string, unknown> = {
          destinationPath: download.destinationPath,
          byteSize: download.byteSize ?? null,
          kind: download.kind,
        };
        const sourceUrl = this.runtimeWorkspaceDownloadUrl(
          typeof download.r2Key === "string" ? download.r2Key : null,
        );
        if (sourceUrl) {
          mapped.sourceUrl = sourceUrl;
        } else if (typeof download.r2Key === "string") {
          mapped.r2Key = download.r2Key;
        } else if (typeof download.sourceUrl === "string") {
          mapped.sourceUrl = download.sourceUrl;
        }
        return mapped;
      })
      : [];
    const preparePayload = {
      ...payload,
      downloads: normalizedDownloads,
    };
    let lastError: unknown = null;
    for (let attempt = 1; attempt <= 2; attempt += 1) {
      try {
        return await this.callRuntime(machineId, "/prepare", {
          method: "POST",
          body: JSON.stringify(preparePayload),
        }, { timeoutMs: options.timeoutMs ?? 12_000 });
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
    return this.createMachineWithMetadata(sessionId);
  }

  private async createMachineWithMetadata(
    sessionId: string,
    options: {
      namePrefix?: string;
      metadata?: Record<string, string>;
      guest?: FlyMachineGuestConfig;
    } = {},
  ): Promise<FlyMachine> {
    const namePrefix = options.namePrefix ?? "alphabook";
    const name = sanitizeMachineName(`${namePrefix}-${sessionId.slice(0, 8)}-${crypto.randomUUID().slice(0, 8)}`);
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
            OPENAI_API_KEY: this.config.openAIApiKey ?? "",
            OPENAI_BASE_URL: this.config.codexOpenAIBaseUrl ?? "http://127.0.0.1:8080/openai-proxy/v1",
            RUNTIME_OPENAI_PROXY_UPSTREAM_BASE_URL: this.config.codexProxyUpstreamBaseUrl ?? "https://api.openai.com/v1",
            CODEX_AUTH_JSON: "",
            RUNTIME_AGENT_MODEL: this.config.runtimeAgentModel ?? DEFAULT_RUNTIME_AGENT_MODEL,
            R2_BUCKET_NAME: this.config.r2BucketName,
            R2_ENDPOINT: this.config.r2Endpoint,
            R2_ACCESS_KEY_ID: this.config.r2AccessKeyId,
            R2_SECRET_ACCESS_KEY: this.config.r2SecretAccessKey,
          },
          guest: {
            cpu_kind: options.guest?.cpu_kind ?? this.config.machineCpuKind ?? "shared",
            cpus: options.guest?.cpus ?? this.config.machineCpus ?? 1,
            memory_mb: options.guest?.memory_mb ?? this.config.machineMemoryMb ?? 1024,
          },
          restart: {
            policy: "no",
          },
          metadata: {
            "alphabook.session_id": sessionId,
            "alphabook.runtime": "true",
            ...(options.metadata ?? {}),
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

  private async listMachines(summary = true): Promise<FlyMachine[]> {
    const suffix = summary ? "?summary=true" : "";
    const response = await this.flyRequest(`/apps/${this.config.appName}/machines${suffix}`, {
      method: "GET",
    });
    return (await response.json()) as FlyMachine[];
  }

  private async waitForMachine(machineId: string, state = "started"): Promise<void> {
    const waitTimeoutSeconds = Math.min(HARD_LIMITS.MAX_RUNTIME_TOOL_TIMEOUT_SECONDS, 60);
    await this.flyRequest(
      `/apps/${this.config.appName}/machines/${machineId}/wait?state=${encodeURIComponent(state)}&timeout=${waitTimeoutSeconds}`,
      { method: "GET" },
      { timeoutMs: (waitTimeoutSeconds + 5) * 1000 },
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

  private runtimeWorkspaceDownloadUrl(r2Key: string | null): string | null {
    if (!r2Key || !this.config.workspaceDownloadBaseUrl || !this.config.runtimeSharedToken) {
      return null;
    }
    const url = new URL("/internal/runtime-file", this.config.workspaceDownloadBaseUrl);
    url.searchParams.set("key", r2Key);
    url.searchParams.set("token", this.config.runtimeSharedToken);
    return url.toString();
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

  async cleanupStaleSpriteMachines(sessionId = ""): Promise<number> {
    const machines = await this.listMachines(true).catch(() => [] as FlyMachine[]);
    const staleMachines = machines.filter((machine) => isStaleSpriteMachine(machine, sessionId));
    if (staleMachines.length === 0) {
      return 0;
    }

    const deletedIds = new Set<string>();
    await this.mapWithConcurrency(staleMachines, 6, async (machine) => {
      try {
        await this.deleteMachine(machine.id);
        deletedIds.add(machine.id);
      } catch {
        // Best-effort cleanup before launching a new fanout.
      }
    });

    return deletedIds.size;
  }

  async listSpriteSessionMachines(sessionId: string) {
    const machines = await this.listMachines(true).catch(() => [] as FlyMachine[]);
    return machines
      .filter((machine) => isMachineForSession(machine, sessionId) && isSpriteRuntimeMachine(machine))
      .map((machine) => {
        const metadata = flyMachineMetadata(machine);
        return {
          machineId: machine.id,
          name: machine.name ?? null,
          state: machine.state ?? null,
          updatedAt: machine.updated_at ?? null,
          runtimeMode: metadata["alphabook.runtime_mode"] ?? null,
          shardId: metadata["alphabook.shard_id"] ?? null,
          implementationId: metadata["alphabook.implementation_id"] ?? null,
        };
      });
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
    const corpusFiles = documentFiles.map((file) => ({
      id: `${file.documentId}:${file.kind}:${file.r2Key}`,
      documentId: file.documentId,
      kind: file.kind as DocumentFileKind,
      r2Key: file.r2Key,
      byteSize: file.byteSize ?? null,
      metadata: file.metadata ?? {},
    }));
    const fileCatalog = dedupeByKey(corpusFiles).map((file) => ({
      documentId: file.documentId,
      kind: file.kind,
      r2Key: file.r2Key,
      destinationPath:
        file.kind === "clean"
          ? `books/${file.documentId}/clean.txt`
          : `chunks/${file.documentId}/chunks.jsonl`,
      byteSize: file.byteSize ?? null,
    }));

    const { hydratedWorkIds: _ignoredHydratedWorkIds, ...restTaskContext } = taskContext;

    const manifest = withLegacyWorkAliases({
      runtimeId,
      sessionId,
      documents: groupDocumentFiles(resolvedWorkIds, corpusFiles, workMetadata),
      dataSchema: defaultCorpusAdapter.workspaceSchema,
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

  private async persistTextArtifact(
    instance: RuntimeInstanceRecord,
    filename: string,
    content: string,
    mimeType: string,
    metadata: Record<string, unknown>,
  ) {
    const existingArtifacts = await this.store.listArtifacts(instance.sessionId, instance.runtimeId);
    const existing = existingArtifacts.find((artifact) => artifact.filename === filename) ?? null;
    if (existing) {
      return {
        filename,
        path: typeof existing.metadata.path === "string" ? existing.metadata.path : filename,
        mimeType: existing.mimeType,
        r2Key: existing.r2Key,
      };
    }

    const r2Key = artifactKeys.runtimeArtifact(instance.runtimeId, filename);
    await this.blobStore.putText(r2Key, content, mimeType);
    await this.store.saveArtifact({
      sessionId: instance.sessionId,
      runtimeId: instance.runtimeId,
      r2Key,
      filename,
      mimeType,
      metadata,
    });
    return {
      filename,
      path: typeof metadata.path === "string" ? metadata.path : filename,
      mimeType,
      r2Key,
    };
  }

  private async persistRuntimeResultStreams(instance: RuntimeInstanceRecord, result: Record<string, unknown>) {
    const inlineArtifacts: Array<Promise<Record<string, unknown> | null>> = [];
    const stdout = typeof result.stdout === "string" ? result.stdout : "";
    const stderr = typeof result.stderr === "string" ? result.stderr : "";

    if (stdout.trim()) {
      inlineArtifacts.push(this.persistTextArtifact(
        instance,
        "runtime-stdout.log",
        stdout,
        "text/plain",
        {
          path: "output/runtime-stdout.log",
          source: "runtime-result",
          stream: "stdout",
        },
      ));
    }
    if (stderr.trim()) {
      inlineArtifacts.push(this.persistTextArtifact(
        instance,
        "runtime-stderr.log",
        stderr,
        "text/plain",
        {
          path: "output/runtime-stderr.log",
          source: "runtime-result",
          stream: "stderr",
        },
      ));
    }

    const resolved = await Promise.all(inlineArtifacts);
    return resolved.filter(Boolean) as Array<Record<string, unknown>>;
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
        mimeType: artifactMimeTypeForPath(path),
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

  private async executeRuntimeTask(
    instance: RuntimeInstanceRecord,
    taskSpec: Record<string, unknown>,
    options: {
      skipMachineStartupCheck?: boolean;
      quietTimeoutMs?: number;
      quietTimeoutMessage?: string;
      onProgress?: (text: string, detail?: Record<string, unknown>) => Promise<void>;
    } = {},
  ) {
    if (!options.skipMachineStartupCheck) {
      await this.ensureMachineRunning(instance);
    }
    await this.store.updateRuntimeInstance(instance.runtimeId, {
      status: "busy",
      lastUsedAt: nowIso(),
      expiresAt: addMinutesIso(HARD_LIMITS.MAX_RUNTIME_IDLE_MINUTES),
    });

    const machineId = instance.providerMachineId ?? instance.runtimeId;
    let seenProgressEvents = 0;
    await this.callRuntime(machineId, "/run-task", {
      method: "POST",
      body: JSON.stringify({
        runtimeId: instance.runtimeId,
        taskSpec,
      }),
    });

    const startedAt = Date.now();
    let lastOutputAt = startedAt;
    let result: Record<string, unknown> | null = null;
    while (Date.now() - startedAt < HARD_LIMITS.MAX_RUN_WALL_CLOCK_SECONDS * 1000) {
      let status: Record<string, unknown>;
      try {
        status = await this.callRuntime(machineId, "/task-status", {
          method: "GET",
        }, { timeoutMs: RUNTIME_STATUS_POLL_TIMEOUT_MS });
      } catch (error) {
        if (options.quietTimeoutMs && Date.now() - lastOutputAt > options.quietTimeoutMs) {
          await this.callRuntime(machineId, "/cancel-task", {
            method: "POST",
            body: JSON.stringify({ runtimeId: instance.runtimeId }),
          }).catch(() => {});
          await this.persistRuntimeArtifactsFromWorkspace(instance);
          const errorMessage = options.quietTimeoutMessage
            ?? "Deep research stopped making progress before the runtime produced a briefing.";
          const timeoutError = new Error(errorMessage) as Error & {
            runtimePayload?: Record<string, unknown>;
          };
          timeoutError.runtimePayload = {
            ok: false,
            error: errorMessage,
            cause: error instanceof Error ? error.message : String(error),
            lastOutputAt: Number.isFinite(lastOutputAt) ? new Date(lastOutputAt).toISOString() : null,
          };
          throw timeoutError;
        }
        await new Promise((resolve) => setTimeout(resolve, 750));
        continue;
      }
      if (options.onProgress && Array.isArray(status.progressEvents)) {
        const progressEvents = status.progressEvents.filter((event): event is Record<string, unknown> =>
          Boolean(event) && typeof event === "object",
        );
        for (let index = seenProgressEvents; index < progressEvents.length; index += 1) {
          const event = progressEvents[index]!;
          await options.onProgress(normalizeRuntimeProgressEvent(event), event);
        }
        seenProgressEvents = progressEvents.length;
      }
      const outputAtCandidate =
        typeof status.lastOutputAt === "string"
          ? Date.parse(status.lastOutputAt)
          : typeof status.updatedAt === "string"
            ? Date.parse(status.updatedAt)
            : Number.NaN;
      if (Number.isFinite(outputAtCandidate) && outputAtCandidate > lastOutputAt) {
        lastOutputAt = outputAtCandidate;
      }
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
      if (options.quietTimeoutMs && Date.now() - lastOutputAt > options.quietTimeoutMs) {
        await this.callRuntime(machineId, "/cancel-task", {
          method: "POST",
          body: JSON.stringify({ runtimeId: instance.runtimeId }),
        }).catch(() => {});
        await this.persistRuntimeArtifactsFromWorkspace(instance);
        const errorMessage = options.quietTimeoutMessage
          ?? "Deep research stopped making progress before the runtime produced a briefing.";
        const error = new Error(errorMessage) as Error & {
          runtimePayload?: Record<string, unknown>;
        };
        error.runtimePayload = {
          ...status,
          error: errorMessage,
          lastOutputAt: Number.isFinite(lastOutputAt) ? new Date(lastOutputAt).toISOString() : null,
        };
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
    const streamArtifacts = await this.persistRuntimeResultStreams(instance, result);
    const workspaceArtifacts = await this.persistRuntimeArtifactsFromWorkspace(instance).catch(() => []);
    await this.store.updateRuntimeInstance(instance.runtimeId, {
      status: "ready",
      lastUsedAt: nowIso(),
      expiresAt: addMinutesIso(HARD_LIMITS.MAX_RUNTIME_IDLE_MINUTES),
    });

    return {
      ...result,
      artifacts: uniqueArtifactEntries([
        ...uploadedArtifacts,
        ...streamArtifacts,
        ...workspaceArtifacts,
      ]),
    };
  }

  private async mapWithConcurrency<T, R>(
    items: T[],
    concurrency: number,
    worker: (item: T, index: number) => Promise<R>,
  ): Promise<R[]> {
    const results = new Array<R>(items.length);
    let nextIndex = 0;
    const lanes = new Array(Math.max(1, Math.min(concurrency, items.length))).fill(null).map(async () => {
      while (nextIndex < items.length) {
        const currentIndex = nextIndex;
        nextIndex += 1;
        results[currentIndex] = await worker(items[currentIndex]!, currentIndex);
      }
    });
    await Promise.all(lanes);
    return results;
  }
}
