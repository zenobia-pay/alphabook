import { hashTextToVector, type WorkSummary } from "@alphabook/shared";

import type { AppDeps, RuntimeToolGateway } from "./app";
import { createApp } from "./app";
import { HashEmbedder } from "./embeddings";
import { FallbackPlanner } from "./planner";
import { MemoryBlobStore } from "./r2";
import { InMemoryAppStore } from "./store";
import { FallbackSynthesizer } from "./synthesizer";

const DEMO_WORKS: Array<WorkSummary & { cleanTextKey: string; chunksKey: string; text: string }> = [
  {
    id: "0f57a12d-07c7-4fcf-bbcc-d743b9c0ba11",
    gutenbergId: 996,
    title: "Don Quixote",
    language: "en",
    releaseDate: "2000-01-01",
    rightsStatus: "public_domain",
    summary: "Knightly delusion, grief, and dignity in a world that refuses to cooperate.",
    authors: ["Miguel de Cervantes"],
    subjects: ["errantry", "melancholy", "fiction"],
    cleanTextKey: "gutenberg/clean/996/clean.txt",
    chunksKey: "gutenberg/clean/996/chunks.jsonl",
    text: "Don Quixote wanders through loss, delusion, endurance, and the poetry of failure. Sancho answers his melancholy with earthy clarity.",
  },
  {
    id: "8d1200e8-c9f6-487d-9508-3fb0af53a8b8",
    gutenbergId: 2701,
    title: "Moby-Dick",
    language: "en",
    releaseDate: "2001-02-01",
    rightsStatus: "public_domain",
    summary: "Obsession, grief, and metaphysical searching aboard the Pequod.",
    authors: ["Herman Melville"],
    subjects: ["sea", "obsession", "grief"],
    cleanTextKey: "gutenberg/clean/2701/clean.txt",
    chunksKey: "gutenberg/clean/2701/chunks.jsonl",
    text: "Ahab frames sorrow as a wound that can only be answered through pursuit. Ishmael turns grief into expansive reflection.",
  },
  {
    id: "68ad951a-7b84-4f2c-82bb-94dc5894dc4e",
    gutenbergId: 145,
    title: "Middlemarch",
    language: "en",
    releaseDate: "2002-03-01",
    rightsStatus: "public_domain",
    summary: "Moral seriousness, social pressure, and the slow texture of disappointment.",
    authors: ["George Eliot"],
    subjects: ["society", "ambition", "interiority"],
    cleanTextKey: "gutenberg/clean/145/clean.txt",
    chunksKey: "gutenberg/clean/145/chunks.jsonl",
    text: "Middlemarch examines inward struggle through disappointment, duty, and the quiet ache of unrealized ideals.",
  },
];

const DEMO_CHUNKS = [
  {
    id: "chunk-dq-1",
    workId: DEMO_WORKS[0].id,
    chunkIndex: 12,
    text: "Don Quixote speaks of grief as a knightly burden, turning sadness into an argument for perseverance and honor.",
    r2Key: DEMO_WORKS[0].chunksKey,
  },
  {
    id: "chunk-dq-2",
    workId: DEMO_WORKS[0].id,
    chunkIndex: 13,
    text: "Sancho keeps dragging the language of sorrow back toward bread, sleep, and practical endurance.",
    r2Key: DEMO_WORKS[0].chunksKey,
  },
  {
    id: "chunk-md-1",
    workId: DEMO_WORKS[1].id,
    chunkIndex: 41,
    text: "Ahab converts grief into obsession, treating his wound as something the whole universe must answer for.",
    r2Key: DEMO_WORKS[1].chunksKey,
  },
  {
    id: "chunk-md-2",
    workId: DEMO_WORKS[1].id,
    chunkIndex: 42,
    text: "Ishmael writes with a looser sadness, where melancholy becomes expansive, speculative, and strangely companionable.",
    r2Key: DEMO_WORKS[1].chunksKey,
  },
  {
    id: "chunk-mm-1",
    workId: DEMO_WORKS[2].id,
    chunkIndex: 18,
    text: "Dorothea's disappointment is rendered as a disciplined inward pain rather than theatrical despair.",
    r2Key: DEMO_WORKS[2].chunksKey,
  },
  {
    id: "chunk-mm-2",
    workId: DEMO_WORKS[2].id,
    chunkIndex: 19,
    text: "Middlemarch treats sorrow as social friction: ideals grind against circumstance until grief settles into ordinary life.",
    r2Key: DEMO_WORKS[2].chunksKey,
  },
].map((chunk) => ({
  ...chunk,
  score: 0,
  excerpt: "",
  embedding: hashTextToVector(chunk.text),
}));

class DemoRuntimeGateway implements RuntimeToolGateway {
  private readonly outputs = new Map<string, string>();

  constructor(private readonly works: Array<WorkSummary & { text: string }>) {}

  async createWorkspace(args: Record<string, unknown>) {
    const runtimeId = crypto.randomUUID();
    this.outputs.set(runtimeId, "");
    return {
      ok: true,
      runtimeId,
      manifest: args,
      reused: false,
    };
  }

  async runWorkspaceTask(args: Record<string, unknown>) {
    const runtimeId = String(args.runtimeId ?? crypto.randomUUID());
    const spec = args.taskSpec as { question?: string; workIds?: string[] } | undefined;
    const relevantWorks = this.works.filter((work) => (spec?.workIds ?? []).includes(work.id));
    const summary = [
      "# Workspace Summary",
      "",
      `Question: ${spec?.question ?? "Unknown question"}`,
      "",
      "The runtime searched the local corpus files and metadata, then condensed the strongest findings:",
      ...relevantWorks.map((work) => `- ${work.title}: ${work.text}`),
    ].join("\n");
    this.outputs.set(runtimeId, summary);
    return {
      ok: true,
      runtimeId,
      stdout: "workspace search complete",
      stderr: "",
      exitCode: 0,
      artifacts: [
        {
          filename: "summary.md",
          path: "output/summary.md",
          mimeType: "text/markdown",
        },
      ],
    };
  }

  async readWorkspaceFile(args: Record<string, unknown>) {
    const runtimeId = String(args.runtimeId ?? "");
    return {
      ok: true,
      path: String(args.path ?? "output/summary.md"),
      content: this.outputs.get(runtimeId) ?? "# Workspace Summary\n\nNo workspace output was captured.",
    };
  }

  async destroyWorkspace(args: Record<string, unknown>) {
    this.outputs.delete(String(args.runtimeId ?? ""));
    return { ok: true };
  }
}

export function createDemoDeps(): AppDeps {
  const blobStore = new MemoryBlobStore();
  for (const work of DEMO_WORKS) {
    blobStore.seed(work.cleanTextKey, work.text);
    blobStore.seed(
      work.chunksKey,
      DEMO_CHUNKS.filter((chunk) => chunk.workId === work.id).map((chunk) => JSON.stringify(chunk)).join("\n"),
    );
  }

  return {
    store: new InMemoryAppStore(DEMO_WORKS, DEMO_CHUNKS),
    planner: new FallbackPlanner(),
    embedder: new HashEmbedder(),
    synthesizer: new FallbackSynthesizer(),
    blobStore,
    runtimeGateway: new DemoRuntimeGateway(DEMO_WORKS),
    queues: {
      ingestName: "alphabook-ingest",
      jobsName: "alphabook-jobs",
    },
  };
}

export function createDemoWorkerApp() {
  return createApp(createDemoDeps());
}
