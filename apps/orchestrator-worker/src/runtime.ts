import { artifactKeys, HARD_LIMITS, withLegacyWorkAliases, type CorpusWorkspaceDocument } from "@alphabook/corpus-core";
import { defaultCorpusAdapter, ToolArgsSchemas, type WorkSummary } from "@alphabook/shared";
import { createPlatformRepository } from "./platform-repository";

import type { RuntimeToolGateway } from "./app";
import type { BlobStore } from "./r2";
import type { AppStore, DocumentFileKind, DocumentFileRecord, RuntimeInstanceRecord } from "./store";

type FetchLike = typeof fetch;

interface ToolExecutionContext {
  sessionId: string;
  runId: string;
}

type RuntimeToolArgs = Record<string, unknown> & Partial<ToolExecutionContext>;
type ProgressReporter = (text: string, detail?: Record<string, unknown>) => Promise<void>;
const PROGRESS_REPORT_TIMEOUT_MS = 1_500;

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

interface SpriteShardManifest {
  implementationId: string;
  shardId: string;
  index: number;
  totalShards: number;
  bookCount: number;
  workIds: string[];
  totalTextBytes: number;
}

interface SpriteShardCatalog {
  implementationId: string;
  generatedAt: string;
  shardSize: number;
  shardCount: number;
  shards: SpriteShardManifest[];
}

interface SpriteFanoutRuntimeArgs extends RuntimeToolArgs {
  query?: string;
  implementationId?: string;
  workIds?: string[];
  intensity?: "normal" | "high" | "maximum";
  progressReporter?: ProgressReporter;
}

type SpriteShardLifecycleState =
  | "queued"
  | "starting"
  | "hydrating"
  | "ready"
  | "searching"
  | "completed"
  | "failed";

type SpriteAggregateLifecycleState = "starting" | "completed" | "failed";

const SPRITE_SHARD_SIZE = 1000;
const MAX_SPRITE_WORKSPACE_BYTES = 2 * 1024 * 1024 * 1024;
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

function spriteShardCatalogKey(implementationId: string): string {
  return `sprite-shards/${implementationId}/catalog.json`;
}

function normalizeSpriteIntensity(value: unknown): "normal" | "high" | "maximum" {
  return value === "high" || value === "maximum" || value === "normal" ? value : "normal";
}

function spriteConcurrencyForIntensity(intensity: "normal" | "high" | "maximum", shardCount: number): number {
  void intensity;
  return Math.max(1, shardCount);
}

function shardLabel(shard: SpriteShardManifest): string {
  return `Part ${shard.index + 1} of ${shard.totalShards}`;
}

function runtimeStatusForShardLifecycle(state: SpriteShardLifecycleState): RuntimeInstanceRecord["status"] {
  if (state === "ready") {
    return "ready";
  }
  if (state === "searching") {
    return "busy";
  }
  if (state === "failed") {
    return "failed";
  }
  if (state === "completed") {
    return "ready";
  }
  return "creating";
}

function withSpriteShardLifecycle(
  manifest: Record<string, unknown>,
  state: SpriteShardLifecycleState,
  extra: Record<string, unknown> = {},
): Record<string, unknown> {
  const taskContext = manifest.taskContext && typeof manifest.taskContext === "object"
    ? manifest.taskContext as Record<string, unknown>
    : {};
  const existingShard = taskContext.spriteShard && typeof taskContext.spriteShard === "object"
    ? taskContext.spriteShard as Record<string, unknown>
    : {};
  return {
    ...manifest,
    taskContext: {
      ...taskContext,
      researchMode: "sprite_fanout",
      spriteShard: {
        ...existingShard,
        lifecycleState: state,
        lastLifecycleAt: nowIso(),
        ...extra,
      },
    },
  };
}

async function safeReportProgress(
  progressReporter: ProgressReporter | undefined,
  text: string,
  detail?: Record<string, unknown>,
) {
  if (!progressReporter) {
    return;
  }
  await Promise.race([
    progressReporter(text, detail).catch(() => {}),
    new Promise<void>((resolve) => {
      setTimeout(resolve, PROGRESS_REPORT_TIMEOUT_MS);
    }),
  ]);
}

function normalizeSpriteProgressMessage(event: Record<string, unknown>, shard: SpriteShardManifest): string | null {
  const rawMessage =
    typeof event.message === "string"
      ? event.message.trim()
      : typeof event.line === "string"
        ? event.line.trim()
        : "";
  if (!rawMessage) {
    return null;
  }
  if (
    /^(OpenAI Codex v|workdir:|model:|provider:|approval:|sandbox:|reasoning effort:|reasoning summaries:|session id:|user|--------)$/iu.test(rawMessage)
    || /^(You are |You operate |Your goal is |Goal:|Constraints:|Research objective:|Task spec:|Workspace manifest summary:|Seed evidence from the orchestrator:|When finished,|Only use local files under |Start from |If the task spec already includes |Keep the search bounded:|Use the remote Postgres database |The CLI turns corpus-wide search requests |Guaranteed tools in this runtime image:|It also supports |Always copy chunk IDs exactly |Use repeated regex, keyword, metadata|Hydrate local book files only |Use shell tools like |To pull files into the workspace|Expand across more books |Create a focused local corpus |Your required deliverable is |The briefing should |Every quote should |Prefer primary-source quotations |Once you have 2 to 8 |If the evidence is thin|You may optionally write helper notes |Do not stop after searching\.)/iu.test(rawMessage)
    || /^[\[\]{}]+,?$/u.test(rawMessage)
  ) {
    return null;
  }
  if (
    /^[\w./-]+\.(?:mjs|json|jsonl|txt|md)$/iu.test(rawMessage)
    || /^(?:exec|search|load|cat|rg|grep|sed|awk|jq|node|python3)$/iu.test(rawMessage)
    || /^[0-9a-f]{8}(?:[-\s][0-9a-f]{4}){3}[-\s][0-9a-f]{12}$/iu.test(rawMessage)
  ) {
    return null;
  }
  if (/ready to run\.$/iu.test(rawMessage)) {
    return null;
  }
  if (/^sending codex corpus briefing to codex\.$/iu.test(rawMessage)) {
    return `Reviewing passages in part ${shard.index + 1} of ${shard.totalShards}.`;
  }
  if (/^retrying codex corpus briefing with codex\.$/iu.test(rawMessage)) {
    return `Retrying the close reading for part ${shard.index + 1} of ${shard.totalShards}.`;
  }
  return rawMessage.length > 220 ? `${rawMessage.slice(0, 217)}...` : rawMessage;
}

function shouldStreamSpriteResearchLine(line: string): boolean {
  const trimmed = line.trim();
  if (!trimmed) {
    return false;
  }
  return !(
    /^(?:#{1,4}\s*)?Early Evidence$/iu.test(trimmed)
    || /^Question:\s+/iu.test(trimmed)
    || /^(?:#{1,4}\s*)?Seed Passages$/iu.test(trimmed)
    || /^(?:#{1,4}\s*)?Strong Local Matches$/iu.test(trimmed)
  );
}

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

function isFlyMachineLimitError(error: unknown): boolean {
  return error instanceof Error && error.message.toLowerCase().includes("reached its machine limit");
}

export function estimateSpritePrepareTimeoutMs(shard: Pick<SpriteShardManifest, "bookCount" | "totalTextBytes">): number {
  const byBookCountMs = shard.bookCount * 150;
  const byBytesMs = Math.ceil(Math.max(0, shard.totalTextBytes) / (2 * 1024 * 1024)) * 1_500;
  return Math.max(90_000, Math.min(10 * 60_000, 45_000 + byBookCountMs + byBytesMs));
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

function isRetryableSpriteLaunchError(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false;
  }
  const message = error.message.toLowerCase();
  return (
    isRetryableRuntimeStartupError(error) ||
    message.includes("fly api request failed (408)") ||
    (
      message.includes("fly api request failed (403)") &&
      (
        message.includes("permission_denied") ||
        message.includes("failed to verify service token") ||
        message.includes("no verified tokens") ||
        message.includes("context deadline exceeded")
      )
    )
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
    return this.executeRuntimeTask(instance, parsed.taskSpec);
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

  async runSpriteFanoutResearch(args: SpriteFanoutRuntimeArgs) {
    const sessionId = this.requireSessionId(args);
    const runId = typeof args.runId === "string" && args.runId.length > 0 ? args.runId : crypto.randomUUID();
    const query = typeof args.query === "string" && args.query.trim().length > 0
      ? args.query.trim()
      : typeof args.task === "string" && args.task.trim().length > 0
        ? args.task.trim()
        : "";
    if (!query) {
      throw new Error("Sprite fanout research requires a non-empty query.");
    }
    const implementationId = typeof args.implementationId === "string" && args.implementationId.trim().length > 0
      ? args.implementationId.trim()
      : "alphabook";
    const intensity = normalizeSpriteIntensity(args.intensity);
    const progressReporter = args.progressReporter;

    const cleanedMachineCount = await this.cleanupStaleSpriteMachines(sessionId);
    if (cleanedMachineCount > 0) {
      await this.store.appendRunEvent(runId, sessionId, "sprite.cleanup.completed", {
        cleanedMachineCount,
        state: "completed",
      });
      await safeReportProgress(
        progressReporter,
        `Cleared ${cleanedMachineCount} older background workers before starting this broad search.`,
        {
          type: "sprite.cleanup_state",
          researchMode: "sprite_fanout",
          cleanedMachineCount,
          state: "completed",
        },
      );
    }

    await safeReportProgress(progressReporter, "Planning a broad search across the library.", {
      type: "research.note",
      researchMode: "sprite_fanout",
      implementationId,
    });
    const catalog = await this.loadSpriteShardCatalog(implementationId);
    await this.store.appendRunEvent(runId, sessionId, "sprite.catalog.loaded", {
      implementationId,
      shardCount: catalog.shardCount,
      shardSize: catalog.shardSize,
    });
    await safeReportProgress(progressReporter, `Prepared ${catalog.shardCount} search groups for a broad pass across the library.`, {
      type: "research.note",
      researchMode: "sprite_fanout",
      implementationId,
      shardCount: catalog.shardCount,
      shardSize: catalog.shardSize,
    });
    const scopedWorkIds = Array.isArray(args.workIds)
      ? args.workIds.filter((value): value is string => typeof value === "string" && value.length > 0)
      : [];
    const selectedShards = scopedWorkIds.length > 0
      ? catalog.shards.filter((shard) => shard.workIds.some((workId) => scopedWorkIds.includes(workId)))
      : catalog.shards;
    if (selectedShards.length === 0) {
      throw new Error("No Sprite shards matched the requested scope.");
    }

    const concurrency = spriteConcurrencyForIntensity(intensity, selectedShards.length);
    await safeReportProgress(
      progressReporter,
      `Starting a broad search across ${selectedShards.length} parts of the library.`,
      {
        type: "research.note",
        researchMode: "sprite_fanout",
        shardCount: selectedShards.length,
        concurrency,
      },
    );
    for (const shard of selectedShards) {
      const label = shardLabel(shard);
      await this.store.appendRunEvent(runId, sessionId, "sprite.shard.queued", {
        implementationId,
        shardId: shard.shardId,
        label,
        state: "queued",
        shardIndex: shard.index,
        totalShards: shard.totalShards,
        bookCount: shard.bookCount,
      });
      await safeReportProgress(progressReporter, `Queued ${label.toLowerCase()} for the broad search.`, {
        type: "sprite.shard_state",
        researchMode: "sprite_fanout",
        shardId: shard.shardId,
        shardLabel: label,
        shardIndex: shard.index,
        totalShards: shard.totalShards,
        bookCount: shard.bookCount,
        state: "queued",
      });
    }

    const shardResults = await this.mapWithConcurrency(selectedShards, concurrency, async (shard) => {
      const label = shardLabel(shard);
      await this.store.appendRunEvent(runId, sessionId, "sprite.shard.started", {
        implementationId,
        shardId: shard.shardId,
        label,
        state: "starting",
        shardIndex: shard.index,
        totalShards: shard.totalShards,
        bookCount: shard.bookCount,
      });
      await safeReportProgress(progressReporter, `Starting ${label.toLowerCase()} across about ${shard.bookCount} books.`, {
        type: "sprite.shard_state",
        researchMode: "sprite_fanout",
        shardId: shard.shardId,
        shardLabel: label,
        shardIndex: shard.index,
        totalShards: shard.totalShards,
        bookCount: shard.bookCount,
        state: "starting",
      });
      const result = await this.runSpriteShard(sessionId, query, shard, {
        runId,
        implementationId,
        intensity,
        progressReporter,
      });
      await this.store.appendRunEvent(runId, sessionId, `sprite.shard.${result.ok ? "completed" : "failed"}`, {
        implementationId,
        shardId: shard.shardId,
        label,
        state: result.ok ? "completed" : "failed",
        shardIndex: shard.index,
        totalShards: shard.totalShards,
        runtimeId: result.runtimeId,
        ...(result.ok ? { citationCount: Array.isArray(result.citations) ? result.citations.length : 0 } : { error: result.error }),
      });
      await safeReportProgress(
        progressReporter,
        result.ok
          ? `Finished ${label.toLowerCase()} and found ${Array.isArray(result.citations) ? result.citations.length : 0} supporting passages.`
          : `${label} stopped before it finished.`,
        {
          type: "sprite.shard_state",
          researchMode: "sprite_fanout",
          shardId: shard.shardId,
          shardLabel: label,
          shardIndex: shard.index,
          totalShards: shard.totalShards,
          bookCount: shard.bookCount,
          runtimeId: result.runtimeId,
          state: result.ok ? "completed" : "failed",
          ok: result.ok,
          ...(typeof result.error === "string" ? { error: result.error } : {}),
        },
      );
      return result;
    });

    const successfulShards = shardResults.filter((result) => result.ok);
    if (successfulShards.length === 0) {
      throw new Error("This broad search took too long across every part of the library, so it stopped before it could write an answer.");
    }

    await safeReportProgress(progressReporter, "Combining the strongest passages into one answer.", {
      type: "sprite.aggregate_state",
      researchMode: "sprite_fanout",
      successfulShardCount: successfulShards.length,
      shardCount: shardResults.length,
      state: "starting",
    });
    await this.store.appendRunEvent(runId, sessionId, "sprite.aggregate.started", {
      implementationId,
      successfulShardCount: successfulShards.length,
      shardCount: shardResults.length,
      state: "starting",
    });
    let aggregateResult: Record<string, unknown>;
    try {
      aggregateResult = await this.runSpriteAggregator(sessionId, query, shardResults, {
        implementationId,
        intensity,
      }) as Record<string, unknown>;
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : "Sprite aggregation failed.";
      await this.store.appendRunEvent(runId, sessionId, "sprite.aggregate.failed", {
        implementationId,
        shardCount: shardResults.length,
        successfulShardCount: successfulShards.length,
        state: "failed",
        error: errorMessage,
      });
      await safeReportProgress(progressReporter, "The final merge stopped before it could finish the answer.", {
        type: "sprite.aggregate_state",
        researchMode: "sprite_fanout",
        successfulShardCount: successfulShards.length,
        shardCount: shardResults.length,
        state: "failed",
        error: errorMessage,
      });
      throw error;
    }
    const aggregateCitations = Array.isArray(aggregateResult.citations)
      ? aggregateResult.citations as Array<Record<string, unknown>>
      : [];
    const aggregateRuntimeId = typeof aggregateResult.runtimeId === "string" ? aggregateResult.runtimeId : "";
    const aggregateBriefing = typeof aggregateResult.briefing === "string" ? aggregateResult.briefing : "";
    const aggregateArtifacts = Array.isArray(aggregateResult.artifacts) ? aggregateResult.artifacts : [];
    await this.store.appendRunEvent(runId, sessionId, "sprite.aggregate.completed", {
      implementationId,
      shardCount: shardResults.length,
      successfulShardCount: successfulShards.length,
      citationCount: aggregateCitations.length,
      aggregatorRuntimeId: aggregateRuntimeId,
      state: "completed",
    });
    await safeReportProgress(progressReporter, "Finished combining the strongest passages into one answer.", {
      type: "sprite.aggregate_state",
      researchMode: "sprite_fanout",
      successfulShardCount: successfulShards.length,
      shardCount: shardResults.length,
      citationCount: aggregateCitations.length,
      aggregatorRuntimeId: aggregateRuntimeId,
      state: "completed",
    });

    return {
      ok: true,
      runtimeId: aggregateRuntimeId,
      briefing: aggregateBriefing,
      citations: aggregateCitations,
      artifacts: aggregateArtifacts,
      shardResults: shardResults.map((result) => ({
        shardId: result.shardId,
        label: result.label,
        ok: result.ok,
        state: result.ok ? "completed" : "failed",
        bookCount: result.bookCount,
        totalTextBytes: result.totalTextBytes,
        runtimeId: result.runtimeId,
        ...(typeof result.error === "string" ? { error: result.error } : {}),
      })),
      chunks: aggregateCitations.slice(0, 12).map((citation, index) => ({
          id: typeof citation.chunkId === "string" ? citation.chunkId : `sprite-citation-${index}`,
          workId: typeof citation.workId === "string" ? citation.workId : "unknown",
          chunkIndex: index,
          excerpt: typeof citation.excerpt === "string" ? citation.excerpt : "",
          text: typeof citation.excerpt === "string" ? citation.excerpt : "",
          title: typeof citation.label === "string" ? citation.label : undefined,
          workTitle: typeof citation.label === "string" ? citation.label : undefined,
          r2Key: typeof citation.r2Key === "string" ? citation.r2Key : null,
        })),
    };
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
    let lastError: unknown = null;
    for (let attempt = 1; attempt <= 2; attempt += 1) {
      try {
        return await this.callRuntime(machineId, "/prepare", {
          method: "POST",
          body: JSON.stringify(payload),
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
            DATABASE_URL: this.config.databaseUrl ?? "",
            CODEX_AUTH_JSON: this.config.codexAuthJson ?? "",
            RUNTIME_AGENT_MODEL: this.config.runtimeAgentModel ?? "gpt-5-codex",
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

  private async buildSpriteWorkspacePlan(
    sessionId: string,
    runtimeId: string,
    workIds: string[],
    taskContext: Record<string, unknown>,
  ) {
    const repository = createPlatformRepository(this.store);
    const resolvedWorkIds = uniqueStrings(workIds);
    const [documents, documentFiles, corpusDocumentCount] = await Promise.all([
      repository.getDocumentMetadata(resolvedWorkIds),
      repository.getDocumentFiles(resolvedWorkIds, ["clean"]),
      repository.countDocuments(),
    ]);
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
    const manifest = withLegacyWorkAliases({
      runtimeId,
      sessionId,
      documents: groupDocumentFiles(resolvedWorkIds, corpusFiles, workMetadata),
      dataSchema: defaultCorpusAdapter.workspaceSchema,
      fileCatalog,
      selectedChunkIds: [],
      selectedChunks: [],
      taskContext: {
        ...taskContext,
        corpusWorkCount: corpusDocumentCount,
        hydratedWorkCount: resolvedWorkIds.length,
      },
    });
    const manifestKey = artifactKeys.runtimeArtifact(runtimeId, "manifest.json");
    await this.blobStore.putJson(manifestKey, manifest);
    await this.store.saveArtifact({
      sessionId,
      runtimeId,
      r2Key: manifestKey,
      filename: "manifest.json",
      mimeType: "application/json",
      metadata: {
        kind: "manifest",
        researchMode: "sprite_fanout",
      },
    });
    const totalBytes = fileCatalog.reduce((sum, file) => sum + (file.byteSize ?? 0), 0);
    if (totalBytes > MAX_SPRITE_WORKSPACE_BYTES) {
      throw new Error(`Sprite shard hydration would exceed ${MAX_SPRITE_WORKSPACE_BYTES} bytes.`);
    }
    return {
      manifest,
      downloads: fileCatalog.map((file) => ({
        r2Key: file.r2Key,
        destinationPath: file.destinationPath,
        byteSize: file.byteSize ?? null,
        kind: file.kind === "clean" ? "clean" : "chunks",
      })),
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

  private async executeRuntimeTask(
    instance: RuntimeInstanceRecord,
    taskSpec: Record<string, unknown>,
    options: { skipMachineStartupCheck?: boolean } = {},
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
    await this.callRuntime(machineId, "/run-task", {
      method: "POST",
      body: JSON.stringify({
        runtimeId: instance.runtimeId,
        taskSpec,
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
    await this.store.updateRuntimeInstance(instance.runtimeId, {
      status: "ready",
      lastUsedAt: nowIso(),
      expiresAt: addMinutesIso(HARD_LIMITS.MAX_RUNTIME_IDLE_MINUTES),
    });

    return {
      ...result,
      artifacts: uploadedArtifacts,
    };
  }

  private async loadSpriteShardCatalog(implementationId: string): Promise<SpriteShardCatalog> {
    const prebuilt = await this.blobStore.getText(spriteShardCatalogKey(implementationId));
    if (prebuilt) {
      const parsed = JSON.parse(prebuilt) as SpriteShardCatalog;
      if (Array.isArray(parsed.shards) && parsed.shards.length > 0) {
        return parsed;
      }
    }

    const totalDocuments = await this.store.countDocuments();
    const documents: Array<{ id: string }> = [];
    for (let offset = 0; offset < totalDocuments; offset += SPRITE_SHARD_SIZE) {
      const batch = await this.store.listDocuments(offset, SPRITE_SHARD_SIZE);
      documents.push(...batch.map((document) => ({ id: document.id })));
    }
    const shards: SpriteShardManifest[] = [];
    for (let index = 0; index < documents.length; index += SPRITE_SHARD_SIZE) {
      const workIds = documents.slice(index, index + SPRITE_SHARD_SIZE).map((document) => document.id);
      const files = await this.store.getDocumentFiles(workIds, ["clean"]);
      shards.push({
        implementationId,
        shardId: `books-${Math.floor(index / SPRITE_SHARD_SIZE) + 1}`,
        index: Math.floor(index / SPRITE_SHARD_SIZE),
        totalShards: Math.max(1, Math.ceil(documents.length / SPRITE_SHARD_SIZE)),
        bookCount: workIds.length,
        workIds,
        totalTextBytes: files.reduce((sum, file) => sum + (file.byteSize ?? 0), 0),
      });
    }
    const catalog: SpriteShardCatalog = {
      implementationId,
      generatedAt: nowIso(),
      shardSize: SPRITE_SHARD_SIZE,
      shardCount: shards.length,
      shards: shards.map((shard) => ({
        ...shard,
        totalShards: shards.length,
      })),
    };
    await this.blobStore.putJson(spriteShardCatalogKey(implementationId), catalog);
    return catalog;
  }

  private startSpriteShardProgressRelay(
    instance: RuntimeInstanceRecord,
    shard: SpriteShardManifest,
    progressReporter?: ProgressReporter,
  ) {
    let stopped = false;
    let inFlight = false;
    let seenCodexLines = 0;
    let seenEvidenceNoteLines = 0;
    let seenBriefingLines = 0;
    const machineId = instance.providerMachineId ?? instance.runtimeId;

    const readFile = async (path: string) => {
      try {
        const result = await this.callRuntime(
          machineId,
          `/file?path=${encodeURIComponent(path)}`,
          { method: "GET" },
        );
        return typeof result.content === "string" ? result.content : "";
      } catch {
        return "";
      }
    };

    const poll = async () => {
      if (stopped || inFlight) {
        return;
      }
      inFlight = true;
      try {
        const codexContent = await readFile("output/codex-progress.jsonl");
        const codexLines = codexContent.split("\n").filter((line) => line.trim().length > 0);
        if (seenCodexLines > codexLines.length) {
          seenCodexLines = 0;
        }
        for (let index = seenCodexLines; index < codexLines.length; index += 1) {
          try {
            const event = JSON.parse(codexLines[index] ?? "{}") as Record<string, unknown>;
            const eventType = typeof event.type === "string" ? event.type : "";
            if (eventType === "research.chunk" || eventType === "research.work") {
              const message =
                typeof event.message === "string" && event.message.trim().length > 0
                  ? event.message.trim()
                  : eventType === "research.chunk"
                    ? `Found a relevant passage in part ${shard.index + 1} of ${shard.totalShards}.`
                    : `Identified a likely book in part ${shard.index + 1} of ${shard.totalShards}.`;
              await safeReportProgress(progressReporter, message, {
                ...event,
                shardId: shard.shardId,
                shardLabel: shardLabel(shard),
                bookCount: shard.bookCount,
              });
              continue;
            }
            const message = normalizeSpriteProgressMessage(event, shard);
            if (!message) {
              continue;
            }
            await safeReportProgress(progressReporter, message, {
              type: "research.note",
              researchMode: "sprite_fanout",
              phase: "search_progress",
              shardId: shard.shardId,
              shardLabel: shardLabel(shard),
              bookCount: shard.bookCount,
              message,
            });
          } catch {
            continue;
          }
        }
        seenCodexLines = codexLines.length;

        const evidenceNotesContent = await readFile("output/evidence-notes.md");
        const evidenceNoteLines = evidenceNotesContent
          .split(/\r?\n/u)
          .map((line) => line.trimEnd())
          .filter((line) => line.trim().length > 0);
        if (seenEvidenceNoteLines > evidenceNoteLines.length) {
          seenEvidenceNoteLines = 0;
        }
        for (let index = seenEvidenceNoteLines; index < evidenceNoteLines.length; index += 1) {
          const line = evidenceNoteLines[index]?.trim();
          if (!line || !shouldStreamSpriteResearchLine(line)) {
            continue;
          }
          await safeReportProgress(progressReporter, line, {
            type: "research.briefing_line",
            line,
            lineIndex: index,
            researchMode: "sprite_fanout",
            shardId: shard.shardId,
            shardLabel: shardLabel(shard),
            bookCount: shard.bookCount,
          });
        }
        seenEvidenceNoteLines = evidenceNoteLines.length;

        const briefingContent = await readFile("output/briefing.md");
        const briefingLines = briefingContent
          .split(/\r?\n/u)
          .map((line) => line.trimEnd())
          .filter((line) => line.trim().length > 0);
        if (seenBriefingLines > briefingLines.length) {
          seenBriefingLines = 0;
        }
        for (let index = seenBriefingLines; index < briefingLines.length; index += 1) {
          const line = briefingLines[index]?.trim();
          if (!line || !shouldStreamSpriteResearchLine(line)) {
            continue;
          }
          await safeReportProgress(progressReporter, line, {
            type: "research.briefing_line",
            line,
            lineIndex: index,
            researchMode: "sprite_fanout",
            shardId: shard.shardId,
            shardLabel: shardLabel(shard),
            bookCount: shard.bookCount,
          });
        }
        seenBriefingLines = briefingLines.length;
      } finally {
        inFlight = false;
      }
    };

    void poll();
    const timer = setInterval(() => {
      void poll();
    }, 1500);

    return {
      stop: () => {
        stopped = true;
        clearInterval(timer);
      },
    };
  }

  private async runSpriteShard(
    sessionId: string,
    query: string,
    shard: SpriteShardManifest,
    options: {
      runId: string;
      implementationId: string;
      intensity: "normal" | "high" | "maximum";
      progressReporter?: ProgressReporter;
    },
  ) {
    let machineId: string | null = null;
    let instance: RuntimeInstanceRecord | null = null;
    let progressRelay: ReturnType<FlyMachinesRuntimeGateway["startSpriteShardProgressRelay"]> | null = null;
    let currentManifest: Record<string, unknown> | null = null;
    const launchAttemptCount = 3;
    const persistShardLifecycle = async (
      runtimeId: string,
      state: SpriteShardLifecycleState,
      extra: Record<string, unknown> = {},
    ) => {
      if (!currentManifest) {
        return;
      }
      currentManifest = withSpriteShardLifecycle(currentManifest, state, extra);
      await this.store.updateRuntimeInstance(runtimeId, {
        status: runtimeStatusForShardLifecycle(state),
        lastUsedAt: nowIso(),
        expiresAt: addMinutesIso(HARD_LIMITS.MAX_RUNTIME_IDLE_MINUTES),
        manifestJson: currentManifest,
        ...(machineId ? { providerMachineId: machineId } : {}),
      });
    };
    try {
      const progressReporter = options.progressReporter;
      const prepareTimeoutMs = estimateSpritePrepareTimeoutMs(shard);
      let lastLaunchError: unknown = null;
      for (let attempt = 1; attempt <= launchAttemptCount; attempt += 1) {
        let attemptMachineId: string | null = null;
        let attemptInstance: RuntimeInstanceRecord | null = null;
        try {
          const machine = await this.createMachineWithMetadata(sessionId, {
            namePrefix: "alphabook-sprite",
            metadata: {
              "alphabook.runtime_mode": "sprite-shard",
              "alphabook.shard_id": shard.shardId,
            },
            guest: spriteGuestConfig("shard", this.config),
          });
          attemptMachineId = machine.id;
          const runtimeId = machine.id;
          const workspacePlan = await this.buildSpriteWorkspacePlan(sessionId, runtimeId, shard.workIds, {
            spriteShard: {
              implementationId: options.implementationId,
              shardId: shard.shardId,
              index: shard.index,
              totalShards: shard.totalShards,
              bookCount: shard.bookCount,
              totalTextBytes: shard.totalTextBytes,
            },
          });
          currentManifest = withSpriteShardLifecycle(workspacePlan.manifest, "starting");
          await this.store.saveRuntimeInstance({
            sessionId,
            runtimeId,
            provider: "fly-sprites",
            providerMachineId: machine.id,
            status: "creating",
            manifestJson: currentManifest,
            lastUsedAt: nowIso(),
            expiresAt: addMinutesIso(HARD_LIMITS.MAX_RUNTIME_IDLE_MINUTES),
          });
          attemptInstance = await this.requireRuntime(runtimeId);
          machineId = machine.id;
          instance = attemptInstance;
          await this.store.appendRunEvent(options.runId, sessionId, "sprite.shard.hydrating", {
            implementationId: options.implementationId,
            shardId: shard.shardId,
            label: shardLabel(shard),
            state: "hydrating",
            shardIndex: shard.index,
            totalShards: shard.totalShards,
            bookCount: shard.bookCount,
            runtimeId,
          });
          await safeReportProgress(progressReporter, `Loading books for ${shardLabel(shard).toLowerCase()}.`, {
            type: "sprite.shard_state",
            researchMode: "sprite_fanout",
            shardId: shard.shardId,
            shardLabel: shardLabel(shard),
            shardIndex: shard.index,
            totalShards: shard.totalShards,
            bookCount: shard.bookCount,
            runtimeId,
            state: "hydrating",
          });
          await persistShardLifecycle(runtimeId, "hydrating");
          await this.waitForMachine(machine.id, "started");
          await this.waitForRuntimeHttpReady(machine.id);
          await this.prepareWorkspace(machine.id, {
            runtimeId,
            sessionId,
            works: currentManifest.works,
            dataSchema: currentManifest.dataSchema,
            fileCatalog: currentManifest.fileCatalog,
            selectedChunkIds: [],
            selectedChunks: [],
            taskContext: currentManifest.taskContext,
            downloads: workspacePlan.downloads,
          }, { timeoutMs: prepareTimeoutMs });
          await persistShardLifecycle(runtimeId, "ready");
          await this.store.appendRunEvent(options.runId, sessionId, "sprite.shard.ready", {
            implementationId: options.implementationId,
            shardId: shard.shardId,
            label: shardLabel(shard),
            state: "ready",
            shardIndex: shard.index,
            totalShards: shard.totalShards,
            bookCount: shard.bookCount,
            runtimeId,
          });
          await safeReportProgress(
            progressReporter,
            `Loaded the books for ${shardLabel(shard).toLowerCase()}. Starting the search now.`,
            {
              type: "sprite.shard_state",
              researchMode: "sprite_fanout",
              shardId: shard.shardId,
              shardLabel: shardLabel(shard),
              shardIndex: shard.index,
              totalShards: shard.totalShards,
              bookCount: shard.bookCount,
              runtimeId,
              state: "ready",
            },
          );
          break;
        } catch (error) {
          lastLaunchError = error;
          if (isFlyMachineLimitError(error)) {
            await this.cleanupStaleSpriteMachines(sessionId).catch(() => {});
          }
          if (attemptInstance) {
            await this.store.updateRuntimeInstance(attemptInstance.runtimeId, {
              status: "failed",
              lastUsedAt: nowIso(),
              expiresAt: addMinutesIso(HARD_LIMITS.MAX_RUNTIME_IDLE_MINUTES),
            }).catch(() => {});
          }
          if (attemptInstance) {
            await this.destroyWorkspace({
              runtimeId: attemptInstance.runtimeId,
              sessionId,
            }).catch(() => {});
          } else if (attemptMachineId) {
            await this.deleteMachine(attemptMachineId).catch(() => {});
          }
          machineId = null;
          instance = null;
          currentManifest = null;
          if (attempt >= launchAttemptCount || !isRetryableSpriteLaunchError(error)) {
            throw error;
          }
          await safeReportProgress(
            progressReporter,
            `${shardLabel(shard)} hit a startup delay. Retrying.`,
            {
              type: "sprite.shard_state",
              researchMode: "sprite_fanout",
              shardId: shard.shardId,
              shardLabel: shardLabel(shard),
              shardIndex: shard.index,
              totalShards: shard.totalShards,
              bookCount: shard.bookCount,
              state: "starting",
              retrying: true,
              attempt,
            },
          );
          await new Promise((resolve) => setTimeout(resolve, attempt * 1_500));
        }
      }
      if (!instance || !machineId) {
        throw lastLaunchError instanceof Error
          ? lastLaunchError
          : new Error(`Failed to launch ${shardLabel(shard)}.`);
      }
      const runtimeId = instance.runtimeId;
      progressRelay = this.startSpriteShardProgressRelay(
        instance,
        shard,
        progressReporter,
      );
      await this.store.appendRunEvent(options.runId, sessionId, "sprite.shard.searching", {
        implementationId: options.implementationId,
        shardId: shard.shardId,
        label: shardLabel(shard),
        state: "searching",
        shardIndex: shard.index,
        totalShards: shard.totalShards,
        bookCount: shard.bookCount,
        runtimeId,
      });
      await persistShardLifecycle(runtimeId, "searching");
      await safeReportProgress(progressReporter, `Searching ${shardLabel(shard).toLowerCase()} now.`, {
        type: "sprite.shard_state",
        researchMode: "sprite_fanout",
        shardId: shard.shardId,
        shardLabel: shardLabel(shard),
        shardIndex: shard.index,
        totalShards: shard.totalShards,
        bookCount: shard.bookCount,
        runtimeId,
        state: "searching",
      });
      const result = await this.executeRuntimeTask(instance, {
        kind: "sprite_fanout_research",
        mode: "sprite_shard_search",
        phase: "collect_and_brief",
        question: query,
        researchObjective: query,
        intensity: options.intensity,
        workIds: shard.workIds,
        shard: {
          shardId: shard.shardId,
          index: shard.index,
          totalShards: shard.totalShards,
          bookCount: shard.bookCount,
          totalTextBytes: shard.totalTextBytes,
        },
        evidenceFile: "output/evidence.json",
        evidenceNotesFile: "output/evidence-notes.md",
        briefingFile: "output/briefing.md",
        briefingJsonFile: "output/briefing.json",
      }, { skipMachineStartupCheck: true });
      await persistShardLifecycle(runtimeId, "completed", {
        citationCount: Array.isArray((result as Record<string, unknown>).citations)
          ? ((result as Record<string, unknown>).citations as unknown[]).length
          : 0,
      });
      return {
        ok: true as const,
        shardId: shard.shardId,
        label: shardLabel(shard),
        runtimeId,
        bookCount: shard.bookCount,
        totalTextBytes: shard.totalTextBytes,
        briefing:
          typeof (result as Record<string, unknown>).briefing === "string"
            ? (result as Record<string, unknown>).briefing as string
            : "",
        citations: Array.isArray((result as Record<string, unknown>).citations)
          ? (result as Record<string, unknown>).citations as unknown[]
          : [],
        artifacts: Array.isArray((result as Record<string, unknown>).artifacts)
          ? (result as Record<string, unknown>).artifacts as unknown[]
          : [],
        shardSummary: (result as Record<string, unknown>).shardSummary,
        result,
      };
    } catch (error) {
      if (instance) {
        await persistShardLifecycle(instance.runtimeId, "failed", {
          error: error instanceof Error ? error.message : "Unknown Sprite shard error",
        }).catch(() => {});
      }
      return {
        ok: false as const,
        shardId: shard.shardId,
        label: shardLabel(shard),
        runtimeId: instance?.runtimeId ?? null,
        bookCount: shard.bookCount,
        totalTextBytes: shard.totalTextBytes,
        error: error instanceof Error ? error.message : "Unknown Sprite shard error",
      };
    } finally {
      progressRelay?.stop();
      if (instance) {
        await this.destroyWorkspace({
          runtimeId: instance.runtimeId,
          sessionId,
        }).catch(() => {});
      } else if (machineId) {
        await this.deleteMachine(machineId).catch(() => {});
      }
    }
  }

  private async runSpriteAggregator(
    sessionId: string,
    query: string,
    shardResults: Array<Record<string, unknown>>,
    options: {
      implementationId: string;
      intensity: "normal" | "high" | "maximum";
    },
  ) {
    const machine = await this.createMachineWithMetadata(sessionId, {
      namePrefix: "alphabook-aggregate",
      metadata: {
        "alphabook.runtime_mode": "sprite-aggregate",
        "alphabook.implementation_id": options.implementationId,
      },
      guest: spriteGuestConfig("aggregate", this.config),
    });
    const runtimeId = machine.id;
    const workspacePlan = await this.buildWorkspacePlan(sessionId, runtimeId, [], [], {
      researchMode: "sprite_fanout",
      aggregator: true,
      implementationId: options.implementationId,
    });
    await this.store.saveRuntimeInstance({
      sessionId,
      runtimeId,
      provider: "fly-sprites",
      providerMachineId: machine.id,
      status: "creating",
      manifestJson: workspacePlan.manifest,
      lastUsedAt: nowIso(),
      expiresAt: addMinutesIso(HARD_LIMITS.MAX_RUNTIME_IDLE_MINUTES),
    });
    const instance = await this.requireRuntime(runtimeId);
    try {
      await this.waitForMachine(machine.id, "started");
      await this.waitForRuntimeHttpReady(machine.id);
      await this.prepareWorkspace(machine.id, {
        runtimeId,
        sessionId,
        works: workspacePlan.manifest.works,
        dataSchema: workspacePlan.manifest.dataSchema,
        fileCatalog: workspacePlan.manifest.fileCatalog,
        selectedChunkIds: [],
        selectedChunks: [],
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
      return await this.executeRuntimeTask(instance, {
        kind: "sprite_fanout_research",
        mode: "sprite_aggregate",
        phase: "collect_and_brief",
        question: query,
        researchObjective: query,
        intensity: options.intensity,
        shardResults,
        evidenceFile: "output/evidence.json",
        evidenceNotesFile: "output/evidence-notes.md",
        briefingFile: "output/briefing.md",
        briefingJsonFile: "output/briefing.json",
      }, { skipMachineStartupCheck: true });
    } finally {
      await this.destroyWorkspace({
        runtimeId,
        sessionId,
      }).catch(() => {});
    }
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
