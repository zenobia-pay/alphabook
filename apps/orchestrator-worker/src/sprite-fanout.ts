import { artifactKeys, HARD_LIMITS, withLegacyWorkAliases, type CorpusWorkspaceDocument } from "@alphabook/corpus-core";
import { defaultCorpusAdapter, type WorkSummary } from "@alphabook/shared";

import { createPlatformRepository } from "./platform-repository";

import type { BlobStore } from "./r2";
import type { AppStore, DocumentFileKind, DocumentFileRecord, RuntimeInstanceRecord } from "./store";

type ProgressReporter = (text: string, detail?: Record<string, unknown>) => Promise<void>;

export interface SpriteShardManifest {
  implementationId: string;
  shardId: string;
  index: number;
  totalShards: number;
  bookCount: number;
  workIds: string[];
  totalTextBytes: number;
}

export interface SpriteShardCatalog {
  implementationId: string;
  generatedAt: string;
  shardSize: number;
  shardCount: number;
  shards: SpriteShardManifest[];
}

export interface SpriteFanoutRuntimeArgs {
  sessionId?: string;
  runId?: string;
  task?: string;
  query?: string;
  implementationId?: string;
  workIds?: string[];
  intensity?: "normal" | "high" | "maximum";
  progressReporter?: ProgressReporter;
}

type WorkspaceDownload = {
  r2Key: string;
  destinationPath: string;
  byteSize?: number | null;
  kind?: "clean" | "chunks";
};

type SpriteShardLifecycleState =
  | "queued"
  | "starting"
  | "hydrating"
  | "ready"
  | "searching"
  | "completed"
  | "failed";

type SpriteMachineGuestConfig = {
  cpu_kind: "shared" | "performance";
  cpus: number;
  memory_mb: number;
};

type SpriteRuntimeCallResult = Record<string, unknown>;

type SpriteRunHost = {
  store: AppStore;
  blobStore: BlobStore;
  cleanupStaleSpriteMachines(sessionId: string): Promise<number>;
  createMachineWithMetadata(
    sessionId: string,
    options: {
      namePrefix: string;
      metadata: Record<string, string>;
      guest: SpriteMachineGuestConfig;
    },
  ): Promise<{ id: string }>;
  waitForMachine(machineId: string, state?: string): Promise<void>;
  waitForRuntimeHttpReady(machineId: string): Promise<void>;
  requireRuntime(runtimeId: string): Promise<RuntimeInstanceRecord>;
  buildWorkspacePlan(
    sessionId: string,
    runtimeId: string,
    workIds: string[],
    chunkIds: string[],
    taskContext: Record<string, unknown>,
  ): Promise<{
    manifest: Record<string, unknown>;
    downloads: WorkspaceDownload[];
  }>;
  prepareWorkspace(
    machineId: string,
    payload: {
      runtimeId: string;
      sessionId: string;
      works: unknown;
      dataSchema: unknown;
      fileCatalog: unknown;
      selectedChunkIds: string[];
      selectedChunks: unknown[];
      taskContext: unknown;
      downloads: WorkspaceDownload[];
    },
    options?: { timeoutMs?: number },
  ): Promise<unknown>;
  executeRuntimeTask(
    instance: RuntimeInstanceRecord,
    taskSpec: Record<string, unknown>,
    options?: {
      skipMachineStartupCheck?: boolean;
      quietTimeoutMs?: number;
      quietTimeoutMessage?: string;
    },
  ): Promise<SpriteRuntimeCallResult>;
  destroyWorkspace(args: { runtimeId: string; sessionId: string }): Promise<unknown>;
  deleteMachine(machineId: string): Promise<void>;
  callRuntime(machineId: string, path: string, init: RequestInit): Promise<Record<string, unknown>>;
  spriteGuestConfig(kind: "shard" | "aggregate"): SpriteMachineGuestConfig;
};

const PROGRESS_REPORT_TIMEOUT_MS = 1_500;
const SPRITE_RUN_EVENT_TIMEOUT_MS = 1_500;
const MAX_SPRITE_SHARD_SIZE = 1000;
const MIN_SPRITE_SHARD_SIZE = 25;
const TARGET_SPRITE_SHARD_COUNT = 12;
const MAX_SPRITE_WORKSPACE_BYTES = 2 * 1024 * 1024 * 1024;
const SPRITE_SHARD_NO_OUTPUT_TIMEOUT_MS = 150_000;

function nowIso(): string {
  return new Date().toISOString();
}

function addMinutesIso(minutes: number): string {
  return new Date(Date.now() + minutes * 60_000).toISOString();
}

function spriteShardCatalogKey(implementationId: string): string {
  return `sprite-shards/${implementationId}/catalog.json`;
}

function normalizeSpriteIntensity(value: unknown): "normal" | "high" | "maximum" {
  return value === "high" || value === "maximum" || value === "normal" ? value : "normal";
}

function spriteConcurrencyForIntensity(_intensity: "normal" | "high" | "maximum", shardCount: number): number {
  return Math.max(1, shardCount);
}

function shardLabel(shard: SpriteShardManifest): string {
  return `Part ${shard.index + 1} of ${shard.totalShards}`;
}

function shouldRetrySpriteShardLaunch(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error ?? "");
  return !(
    /every requested clean text was missing from R2/iu.test(message)
    || /Failed to download .* The specified key does not exist/iu.test(message)
    || /NoSuchKey/iu.test(message)
  );
}

function summarizeSpriteShardFailures(
  shardResults: Array<{ label: string; error?: string | null }>,
): string {
  const failures = shardResults
    .map((result) => ({
      label: result.label,
      error: typeof result.error === "string" ? result.error.trim() : "",
    }))
    .filter((result) => result.error.length > 0);
  if (failures.length === 0) {
    return "No shard searches completed successfully.";
  }
  if (failures.length === 1) {
    return `${failures[0]!.label} failed: ${failures[0]!.error}`;
  }
  return `No shard searches completed successfully. First failure: ${failures[0]!.label} failed: ${failures[0]!.error}`;
}

function runtimeStatusForShardLifecycle(state: SpriteShardLifecycleState): RuntimeInstanceRecord["status"] {
  if (state === "ready" || state === "completed") {
    return "ready";
  }
  if (state === "searching") {
    return "busy";
  }
  if (state === "failed") {
    return "failed";
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

async function safeAppendRunEvent(
  store: AppStore,
  runId: string,
  sessionId: string,
  event: string,
  dataJson: Record<string, unknown>,
) {
  await Promise.race([
    store.appendRunEvent(runId, sessionId, event, dataJson).catch(() => {}),
    new Promise<void>((resolve) => {
      setTimeout(resolve, SPRITE_RUN_EVENT_TIMEOUT_MS);
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
    || /^(You are |You operate |Your goal is |Goal:|Constraints:|Research objective:|Task spec:|Workspace manifest summary:|Seed evidence from the orchestrator:|When finished,|Only use local files under |Start from |If the task spec already includes |Keep the search bounded:|Guaranteed tools in this runtime image:|It also supports |Always copy chunk IDs exactly |Use repeated regex, keyword, metadata|Hydrate local book files only |Use shell tools like |To pull files into the workspace|Expand across more books |Create a focused local corpus |Your required deliverable is |The briefing should |Every quote should |Prefer primary-source quotations |Once you have 2 to 8 |If the evidence is thin|You may optionally write helper notes |Do not stop after searching\.)/iu.test(rawMessage)
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

function totalBooksInCatalog(catalog: SpriteShardCatalog): number {
  return catalog.shards.reduce((sum, shard) => sum + shard.bookCount, 0);
}

function spriteShardSizeForDocumentCount(totalDocuments: number): number {
  if (totalDocuments <= 0) {
    return MAX_SPRITE_SHARD_SIZE;
  }
  return Math.min(
    MAX_SPRITE_SHARD_SIZE,
    Math.max(MIN_SPRITE_SHARD_SIZE, Math.ceil(totalDocuments / TARGET_SPRITE_SHARD_COUNT)),
  );
}

export function isSpriteShardCatalogUsable(catalog: SpriteShardCatalog, expectedDocumentCount: number): boolean {
  if (!Array.isArray(catalog.shards) || catalog.shards.length === 0) {
    return false;
  }
  const shardSize = spriteShardSizeForDocumentCount(expectedDocumentCount);
  const expectedShardCount = Math.max(1, Math.ceil(expectedDocumentCount / shardSize));
  return totalBooksInCatalog(catalog) === expectedDocumentCount
    && catalog.shardSize === shardSize
    && catalog.shardCount === expectedShardCount;
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

async function loadSpriteShardCatalog(store: AppStore, blobStore: BlobStore, implementationId: string): Promise<SpriteShardCatalog> {
  const totalDocuments = await store.countDocuments();
  const shardSize = spriteShardSizeForDocumentCount(totalDocuments);
  const prebuilt = await blobStore.getText(spriteShardCatalogKey(implementationId));
  if (prebuilt) {
    const parsed = JSON.parse(prebuilt) as SpriteShardCatalog;
    if (isSpriteShardCatalogUsable(parsed, totalDocuments)) {
      return parsed;
    }
  }

  const documents: Array<{ id: string }> = [];
  for (let offset = 0; offset < totalDocuments; offset += shardSize) {
    const batch = await store.listDocuments(offset, shardSize);
    documents.push(...batch.map((document) => ({ id: document.id })));
  }
  const shards: SpriteShardManifest[] = [];
  for (let index = 0; index < documents.length; index += shardSize) {
    const workIds = documents.slice(index, index + shardSize).map((document) => document.id);
    const files = await store.getDocumentFiles(workIds, ["clean"]);
    shards.push({
      implementationId,
      shardId: `books-${Math.floor(index / shardSize) + 1}`,
      index: Math.floor(index / shardSize),
      totalShards: Math.max(1, Math.ceil(documents.length / shardSize)),
      bookCount: workIds.length,
      workIds,
      totalTextBytes: files.reduce((sum, file) => sum + (file.byteSize ?? 0), 0),
    });
  }
  const catalog: SpriteShardCatalog = {
    implementationId,
    generatedAt: nowIso(),
    shardSize,
    shardCount: shards.length,
    shards: shards.map((shard) => ({
      ...shard,
      totalShards: shards.length,
    })),
  };
  await blobStore.putJson(spriteShardCatalogKey(implementationId), catalog);
  return catalog;
}

export function estimateSpritePrepareTimeoutMs(shard: Pick<SpriteShardManifest, "bookCount" | "totalTextBytes">): number {
  const byBookCountMs = shard.bookCount * 150;
  const byBytesMs = Math.ceil(Math.max(0, shard.totalTextBytes) / (2 * 1024 * 1024)) * 1_500;
  return Math.max(90_000, Math.min(10 * 60_000, 45_000 + byBookCountMs + byBytesMs));
}

async function buildSpriteWorkspacePlan(
  store: AppStore,
  blobStore: BlobStore,
  sessionId: string,
  runtimeId: string,
  workIds: string[],
  taskContext: Record<string, unknown>,
) {
  const repository = createPlatformRepository(store);
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
  await blobStore.putJson(manifestKey, manifest);
  await store.saveArtifact({
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
        kind: (file.kind === "clean" ? "clean" : "chunks") as "clean" | "chunks",
      })),
  };
}

function startSpriteShardProgressRelay(
  host: SpriteRunHost,
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
      const result = await host.callRuntime(
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
  }, 1_500);

  return {
    stop() {
      stopped = true;
      clearInterval(timer);
    },
  };
}

async function mapWithConcurrency<T, R>(
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

type SpriteRunOptions = {
  runId: string;
  implementationId: string;
  intensity: "normal" | "high" | "maximum";
  progressReporter?: ProgressReporter;
};

async function runSpriteShard(
  host: SpriteRunHost,
  sessionId: string,
  query: string,
  shard: SpriteShardManifest,
  options: SpriteRunOptions,
) {
  let machineId: string | null = null;
  let instance: RuntimeInstanceRecord | null = null;
  let progressRelay: ReturnType<typeof startSpriteShardProgressRelay> | null = null;
  let currentManifest: Record<string, unknown> | null = null;
  let lastLaunchError: unknown = null;
  const launchAttemptCount = 3;
  const progressReporter = options.progressReporter;

  const persistShardLifecycle = async (
    runtimeId: string,
    state: SpriteShardLifecycleState,
    extra: Record<string, unknown> = {},
  ) => {
    if (!currentManifest) {
      return;
    }
    currentManifest = withSpriteShardLifecycle(currentManifest, state, extra);
    await host.store.updateRuntimeInstance(runtimeId, {
      status: runtimeStatusForShardLifecycle(state),
      lastUsedAt: nowIso(),
      expiresAt: addMinutesIso(HARD_LIMITS.MAX_RUNTIME_IDLE_MINUTES),
      manifestJson: currentManifest,
      ...(machineId ? { providerMachineId: machineId } : {}),
    });
  };

  try {
    const prepareTimeoutMs = estimateSpritePrepareTimeoutMs(shard);
    for (let attempt = 1; attempt <= launchAttemptCount; attempt += 1) {
      let attemptMachineId: string | null = null;
      let attemptInstance: RuntimeInstanceRecord | null = null;
      try {
        const machine = await host.createMachineWithMetadata(sessionId, {
          namePrefix: "alphabook-sprite",
          metadata: {
            "alphabook.runtime_mode": "sprite-shard",
            "alphabook.shard_id": shard.shardId,
          },
          guest: host.spriteGuestConfig("shard"),
        });
        attemptMachineId = machine.id;
        const runtimeId = machine.id;
        const workspacePlan = await buildSpriteWorkspacePlan(
          host.store,
          host.blobStore,
          sessionId,
          runtimeId,
          shard.workIds,
          {
            spriteShard: {
              implementationId: options.implementationId,
              shardId: shard.shardId,
              index: shard.index,
              totalShards: shard.totalShards,
              bookCount: shard.bookCount,
              totalTextBytes: shard.totalTextBytes,
            },
          },
        );
        currentManifest = withSpriteShardLifecycle(workspacePlan.manifest, "starting");
        await host.store.saveRuntimeInstance({
          sessionId,
          runtimeId,
          provider: "fly-sprites",
          providerMachineId: machine.id,
          status: "creating",
          manifestJson: currentManifest,
          lastUsedAt: nowIso(),
          expiresAt: addMinutesIso(HARD_LIMITS.MAX_RUNTIME_IDLE_MINUTES),
        });
        attemptInstance = await host.requireRuntime(runtimeId);
        machineId = machine.id;
        instance = attemptInstance;
        await safeAppendRunEvent(host.store, options.runId, sessionId, "sprite.shard.hydrating", {
          implementationId: options.implementationId,
          shardId: shard.shardId,
          label: shardLabel(shard),
          state: "hydrating",
          shardIndex: shard.index,
          totalShards: shard.totalShards,
          bookCount: shard.bookCount,
          runtimeId,
          providerMachineId: machine.id,
          attempt,
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
        await host.waitForMachine(machine.id, "started");
        await host.waitForRuntimeHttpReady(machine.id);
        await host.prepareWorkspace(machine.id, {
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
        await safeAppendRunEvent(host.store, options.runId, sessionId, "sprite.shard.ready", {
          implementationId: options.implementationId,
          shardId: shard.shardId,
          label: shardLabel(shard),
          state: "ready",
          shardIndex: shard.index,
          totalShards: shard.totalShards,
          bookCount: shard.bookCount,
          runtimeId,
          providerMachineId: machine.id,
          attempt,
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
        await safeAppendRunEvent(host.store, options.runId, sessionId, "sprite.shard.launch_failed", {
          implementationId: options.implementationId,
          shardId: shard.shardId,
          label: shardLabel(shard),
          state: "starting",
          shardIndex: shard.index,
          totalShards: shard.totalShards,
          bookCount: shard.bookCount,
          runtimeId: attemptInstance?.runtimeId ?? attemptMachineId,
          providerMachineId: attemptMachineId,
          attempt,
          error: error instanceof Error ? error.message : "Unknown Sprite shard startup error",
        });
        if (attemptInstance) {
          await host.store.updateRuntimeInstance(attemptInstance.runtimeId, {
            status: "failed",
            lastUsedAt: nowIso(),
            expiresAt: addMinutesIso(HARD_LIMITS.MAX_RUNTIME_IDLE_MINUTES),
          }).catch(() => {});
        }
        if (attemptMachineId) {
          await host.deleteMachine(attemptMachineId).catch(() => {});
        }
        machineId = null;
        instance = null;
        currentManifest = null;
        if (attempt >= launchAttemptCount || !shouldRetrySpriteShardLaunch(error)) {
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
      throw lastLaunchError instanceof Error ? lastLaunchError : new Error(`Failed to launch ${shardLabel(shard)}.`);
    }

    progressRelay = startSpriteShardProgressRelay(host, instance, shard, progressReporter);
    await safeAppendRunEvent(host.store, options.runId, sessionId, "sprite.shard.searching", {
      implementationId: options.implementationId,
      shardId: shard.shardId,
      label: shardLabel(shard),
      state: "searching",
      shardIndex: shard.index,
      totalShards: shard.totalShards,
      bookCount: shard.bookCount,
      runtimeId: instance.runtimeId,
      providerMachineId: machineId,
    });
    await persistShardLifecycle(instance.runtimeId, "searching");
    await safeReportProgress(progressReporter, `Searching ${shardLabel(shard).toLowerCase()} now.`, {
      type: "sprite.shard_state",
      researchMode: "sprite_fanout",
      shardId: shard.shardId,
      shardLabel: shardLabel(shard),
      shardIndex: shard.index,
      totalShards: shard.totalShards,
      bookCount: shard.bookCount,
      runtimeId: instance.runtimeId,
      state: "searching",
    });

    const result = await host.executeRuntimeTask(instance, {
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
    }, {
      skipMachineStartupCheck: true,
      quietTimeoutMs: SPRITE_SHARD_NO_OUTPUT_TIMEOUT_MS,
      quietTimeoutMessage: `${shardLabel(shard)} stopped producing evidence or draft text before it finished.`,
    });

    const citations = Array.isArray(result.citations) ? result.citations : [];
    await persistShardLifecycle(instance.runtimeId, "completed", {
      citationCount: citations.length,
    });
    return {
      ok: true as const,
      shardId: shard.shardId,
      label: shardLabel(shard),
      runtimeId: instance.runtimeId,
      bookCount: shard.bookCount,
      totalTextBytes: shard.totalTextBytes,
      briefing: typeof result.briefing === "string" ? result.briefing : "",
      citations,
      artifacts: Array.isArray(result.artifacts) ? result.artifacts : [],
      shardSummary: result.shardSummary,
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
      await host.destroyWorkspace({
        runtimeId: instance.runtimeId,
        sessionId,
      }).catch(() => {});
    } else if (machineId) {
      await host.deleteMachine(machineId).catch(() => {});
    }
  }
}

async function runSpriteAggregator(
  host: SpriteRunHost,
  sessionId: string,
  query: string,
  shardResults: Array<Record<string, unknown>>,
  options: {
    runId: string;
    implementationId: string;
    intensity: "normal" | "high" | "maximum";
  },
) {
  const machine = await host.createMachineWithMetadata(sessionId, {
    namePrefix: "alphabook-aggregate",
    metadata: {
      "alphabook.runtime_mode": "sprite-aggregate",
      "alphabook.implementation_id": options.implementationId,
    },
    guest: host.spriteGuestConfig("aggregate"),
  });
  const runtimeId = machine.id;
  const workspacePlan = await host.buildWorkspacePlan(sessionId, runtimeId, [], [], {
    researchMode: "sprite_fanout",
    aggregator: true,
    implementationId: options.implementationId,
  });
  await host.store.saveRuntimeInstance({
    sessionId,
    runtimeId,
    provider: "fly-sprites",
    providerMachineId: machine.id,
    status: "creating",
    manifestJson: workspacePlan.manifest,
    lastUsedAt: nowIso(),
    expiresAt: addMinutesIso(HARD_LIMITS.MAX_RUNTIME_IDLE_MINUTES),
  });
  const instance = await host.requireRuntime(runtimeId);
  try {
    await host.waitForMachine(machine.id, "started");
    await host.waitForRuntimeHttpReady(machine.id);
    await host.prepareWorkspace(machine.id, {
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
    await host.store.updateRuntimeInstance(runtimeId, {
      status: "ready",
      lastUsedAt: nowIso(),
      expiresAt: addMinutesIso(HARD_LIMITS.MAX_RUNTIME_IDLE_MINUTES),
      manifestJson: workspacePlan.manifest,
      providerMachineId: machine.id,
    });
    await safeAppendRunEvent(host.store, options.runId, sessionId, "sprite.aggregate.ready", {
      implementationId: options.implementationId,
      state: "ready",
      runtimeId,
      providerMachineId: machine.id,
    });
    return await host.executeRuntimeTask(instance, {
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
    await host.destroyWorkspace({
      runtimeId,
      sessionId,
    }).catch(() => {});
  }
}

export class SpriteFanoutCoordinator {
  constructor(private readonly host: SpriteRunHost) {}

  async run(args: SpriteFanoutRuntimeArgs) {
    const sessionId = typeof args.sessionId === "string" && args.sessionId.length > 0
      ? args.sessionId
      : (() => { throw new Error("Runtime tool requires a sessionId."); })();
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

    const cleanedMachineCount = await this.host.cleanupStaleSpriteMachines(sessionId);
    if (cleanedMachineCount > 0) {
      await safeAppendRunEvent(this.host.store, runId, sessionId, "sprite.cleanup.completed", {
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
    const catalog = await loadSpriteShardCatalog(this.host.store, this.host.blobStore, implementationId);
    await safeAppendRunEvent(this.host.store, runId, sessionId, "sprite.catalog.loaded", {
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
    await safeReportProgress(progressReporter, `Starting a broad search across ${selectedShards.length} parts of the library.`, {
      type: "research.note",
      researchMode: "sprite_fanout",
      shardCount: selectedShards.length,
      concurrency,
    });
    for (const shard of selectedShards) {
      const label = shardLabel(shard);
      await safeAppendRunEvent(this.host.store, runId, sessionId, "sprite.shard.queued", {
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

    const shardResults = await mapWithConcurrency(selectedShards, concurrency, async (shard) => {
      const label = shardLabel(shard);
      await safeAppendRunEvent(this.host.store, runId, sessionId, "sprite.shard.started", {
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

      const result = await runSpriteShard(this.host, sessionId, query, shard, {
        runId,
        implementationId,
        intensity,
        progressReporter,
      });
      await safeAppendRunEvent(this.host.store, runId, sessionId, `sprite.shard.${result.ok ? "completed" : "failed"}`, {
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
      throw new Error(summarizeSpriteShardFailures(shardResults));
    }

    await safeReportProgress(progressReporter, "Combining the strongest passages into one answer.", {
      type: "sprite.aggregate_state",
      researchMode: "sprite_fanout",
      successfulShardCount: successfulShards.length,
      shardCount: shardResults.length,
      state: "starting",
    });
    await safeAppendRunEvent(this.host.store, runId, sessionId, "sprite.aggregate.started", {
      implementationId,
      successfulShardCount: successfulShards.length,
      shardCount: shardResults.length,
      state: "starting",
    });

    let aggregateResult: Record<string, unknown>;
    try {
      aggregateResult = await runSpriteAggregator(this.host, sessionId, query, shardResults, {
        runId,
        implementationId,
        intensity,
      });
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : "Sprite aggregation failed.";
      await safeAppendRunEvent(this.host.store, runId, sessionId, "sprite.aggregate.failed", {
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
    await safeAppendRunEvent(this.host.store, runId, sessionId, "sprite.aggregate.completed", {
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
}
