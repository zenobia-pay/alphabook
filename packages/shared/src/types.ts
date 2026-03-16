import { z } from "zod";

export const ToolNameSchema = z.enum([
  "search_works",
  "get_work_metadata",
  "get_relevant_chunks",
  "get_work_text",
  "create_workspace",
  "run_workspace_task",
  "read_workspace_file",
  "destroy_workspace",
]);

export type ToolName = z.infer<typeof ToolNameSchema>;

export const CitationSchema = z.object({
  workId: z.string(),
  chunkId: z.string().optional(),
  label: z.string(),
  excerpt: z.string(),
  r2Key: z.string().optional(),
});

export type Citation = z.infer<typeof CitationSchema>;

export const SearchWorksArgsSchema = z.object({
  query: z.string().min(1),
  filters: z
    .object({
      language: z.string().optional(),
      rightsStatus: z.string().optional(),
      subjects: z.array(z.string()).optional(),
      limit: z.number().int().positive().max(20).optional(),
    })
    .optional(),
});

export const GetWorkMetadataArgsSchema = z.object({
  workIds: z.array(z.string()).min(1).max(20),
});

export const GetRelevantChunksArgsSchema = z.object({
  query: z.string().min(1),
  workIds: z.array(z.string()).max(20).optional(),
  filters: z
    .object({
      limit: z.number().int().positive().max(20).optional(),
      language: z.string().optional(),
    })
    .optional(),
});

export const GetWorkTextArgsSchema = z.object({
  workId: z.string(),
});

export const CreateWorkspaceArgsSchema = z.object({
  workIds: z.array(z.string()).max(20),
  chunkIds: z.array(z.string()).max(100),
  taskContext: z.record(z.string(), z.unknown()).default({}),
});

export const RunWorkspaceTaskArgsSchema = z.object({
  runtimeId: z.string(),
  taskSpec: z.record(z.string(), z.unknown()),
});

export const ReadWorkspaceFileArgsSchema = z.object({
  runtimeId: z.string(),
  path: z.string(),
});

export const DestroyWorkspaceArgsSchema = z.object({
  runtimeId: z.string(),
});

export const ToolArgsSchemas = {
  search_works: SearchWorksArgsSchema,
  get_work_metadata: GetWorkMetadataArgsSchema,
  get_relevant_chunks: GetRelevantChunksArgsSchema,
  get_work_text: GetWorkTextArgsSchema,
  create_workspace: CreateWorkspaceArgsSchema,
  run_workspace_task: RunWorkspaceTaskArgsSchema,
  read_workspace_file: ReadWorkspaceFileArgsSchema,
  destroy_workspace: DestroyWorkspaceArgsSchema,
} as const;

export const PlannerToolCallSchema = z.object({
  type: z.literal("tool_call"),
  tool_name: ToolNameSchema,
  args: z.record(z.string(), z.unknown()),
  rationale: z.string().optional(),
});

export const PlannerFinalAnswerSchema = z.object({
  type: z.literal("final_answer"),
  answer: z.string(),
  citations: z.array(CitationSchema),
});

export const PlannerDecisionSchema = z.union([PlannerToolCallSchema, PlannerFinalAnswerSchema]);

export type PlannerDecision = z.infer<typeof PlannerDecisionSchema>;
export type PlannerToolCall = z.infer<typeof PlannerToolCallSchema>;
export type PlannerFinalAnswer = z.infer<typeof PlannerFinalAnswerSchema>;

export const ChatRequestSchema = z.object({
  sessionId: z.string().uuid().optional(),
  userId: z.string().min(1).optional(),
  message: z.string().min(1),
  workIds: z.array(z.string()).optional(),
  stream: z.boolean().optional(),
});

export type ChatRequest = z.infer<typeof ChatRequestSchema>;

export const HealthResponseSchema = z.object({
  status: z.literal("ok"),
  service: z.string(),
  database: z.string(),
  r2: z.string(),
  queues: z.object({
    ingest: z.string(),
    jobs: z.string(),
  }),
  limits: z.object({
    maxTurns: z.number(),
    maxRuntimeTasksPerRun: z.number(),
    maxRunWallClockSeconds: z.number(),
  }),
});

export type HealthResponse = z.infer<typeof HealthResponseSchema>;

export const StreamEventSchema = z.object({
  event: z.string(),
  data: z.record(z.string(), z.unknown()),
});

export type StreamEvent = z.infer<typeof StreamEventSchema>;

export const ChatSessionSummarySchema = z.object({
  id: z.string().uuid(),
  userId: z.string(),
  title: z.string().nullable(),
  createdAt: z.string(),
  lastMessageAt: z.string().nullable(),
  lastMessagePreview: z.string().nullable(),
});

export type ChatSessionSummary = z.infer<typeof ChatSessionSummarySchema>;

export const MessageRecordSchema = z.object({
  id: z.string().uuid(),
  sessionId: z.string().uuid(),
  role: z.enum(["user", "assistant", "system", "tool"]),
  content: z.string(),
  metadata: z.record(z.string(), z.unknown()),
  createdAt: z.string(),
});

export type MessageRecord = z.infer<typeof MessageRecordSchema>;

export const SessionListResponseSchema = z.object({
  sessions: z.array(ChatSessionSummarySchema),
});

export type SessionListResponse = z.infer<typeof SessionListResponseSchema>;

export const MessageListResponseSchema = z.object({
  messages: z.array(MessageRecordSchema),
});

export type MessageListResponse = z.infer<typeof MessageListResponseSchema>;

export const UserProfileSchema = z.object({
  id: z.string(),
  email: z.string().email().nullable(),
  handle: z.string().nullable().default(null),
  name: z.string().nullable(),
  avatarUrl: z.string().url().nullable(),
  createdAt: z.string(),
  followersCount: z.number().int().nonnegative().default(0),
  followingCount: z.number().int().nonnegative().default(0),
});

export type UserProfile = z.infer<typeof UserProfileSchema>;

export const CurrentUserResponseSchema = z.object({
  authenticated: z.boolean(),
  authConfigured: z.boolean(),
  user: UserProfileSchema.nullable(),
});

export type CurrentUserResponse = z.infer<typeof CurrentUserResponseSchema>;

export const PublicProfileResponseSchema = z.object({
  profile: UserProfileSchema,
  isFollowing: z.boolean(),
  isSelf: z.boolean(),
});

export type PublicProfileResponse = z.infer<typeof PublicProfileResponseSchema>;

export const FollowProfileResponseSchema = z.object({
  ok: z.literal(true),
  profile: UserProfileSchema,
  isFollowing: z.boolean(),
});

export type FollowProfileResponse = z.infer<typeof FollowProfileResponseSchema>;

export const WorkSummarySchema = z.object({
  id: z.string(),
  gutenbergId: z.number().nullable(),
  title: z.string(),
  subtitle: z.string().nullable().optional(),
  coverImageUrl: z.string().nullable().optional(),
  hasCoverImage: z.boolean().optional(),
  language: z.string().nullable(),
  releaseDate: z.string().nullable(),
  rightsStatus: z.string().nullable(),
  summary: z.string().nullable(),
  publisher: z.string().nullable().optional(),
  authors: z.array(z.string()).default([]),
  subjects: z.array(z.string()).default([]),
  bookshelves: z.array(z.string()).optional(),
  translators: z.array(z.string()).optional(),
  illustrators: z.array(z.string()).optional(),
  editors: z.array(z.string()).optional(),
  score: z.number().optional(),
  feedLabel: z.string().nullable().optional(),
});

export type WorkSummary = z.infer<typeof WorkSummarySchema>;

export const WorkDetailSchema = WorkSummarySchema.extend({
  metadata: z.record(z.string(), z.unknown()).default({}),
});

export type WorkDetail = z.infer<typeof WorkDetailSchema>;

export const WorkListResponseSchema = z.object({
  works: z.array(WorkSummarySchema),
  nextOffset: z.number().nullable(),
  totalCount: z.number().int().nonnegative(),
});

export type WorkListResponse = z.infer<typeof WorkListResponseSchema>;

export const WorkSourceSchema = z.object({
  format: z.enum(["html", "text"]),
  content: z.string(),
  r2Key: z.string().nullable(),
  sourcePath: z.string().nullable(),
  metadataPath: z.string().nullable(),
});

export type WorkSource = z.infer<typeof WorkSourceSchema>;

export const WorkDetailResponseSchema = z.object({
  work: WorkDetailSchema,
  source: WorkSourceSchema.nullable(),
});

export type WorkDetailResponse = z.infer<typeof WorkDetailResponseSchema>;

export const ChunkSearchResultSchema = z.object({
  id: z.string(),
  workId: z.string(),
  chunkIndex: z.number(),
  text: z.string(),
  r2Key: z.string().nullable(),
  score: z.number(),
  excerpt: z.string(),
});

export type ChunkSearchResult = z.infer<typeof ChunkSearchResultSchema>;

export const ToolResultSchema = z.object({
  ok: z.boolean(),
  toolName: ToolNameSchema,
  data: z.record(z.string(), z.unknown()).optional(),
  error: z.string().optional(),
});

export type ToolResult = z.infer<typeof ToolResultSchema>;

export interface WorkspaceManifest {
  runtimeId: string;
  sessionId: string;
  works: Array<{
    workId: string;
    title?: string;
    authors?: string[];
    language?: string | null;
    releaseDate?: string | null;
    rightsStatus?: string | null;
    summary?: string | null;
    subjects?: string[];
    cleanTextKey?: string;
    chunksKey?: string;
  }>;
  dataSchema?: Record<string, unknown>;
  fileCatalog?: Array<{
    workId: string;
    kind: string;
    r2Key: string;
    destinationPath: string;
    byteSize?: number | null;
  }>;
  selectedChunkIds: string[];
  selectedChunks?: Array<{
    id: string;
    workId: string;
    chunkIndex: number;
    text: string;
    excerpt: string;
    r2Key?: string | null;
  }>;
  taskContext: Record<string, unknown>;
}

export interface RuntimeTaskResult {
  runtimeId: string;
  stdout: string;
  stderr: string;
  exitCode: number;
  evidenceNotes?: string;
  briefing?: string;
  citations?: Citation[];
  codexRuns?: Array<{
    step: string;
    promptPath: string;
    outputPath: string;
    logPath: string;
    exitCode: number;
  }>;
  billingEvents?: Array<{
    provider: string;
    model: string;
    operation: string;
    inputTokens: number;
    outputTokens: number;
    totalTokens: number;
    cachedInputTokens: number;
    requestId?: string | null;
    createdAt?: string;
    metadata?: Record<string, unknown>;
  }>;
  artifacts: Array<{ path: string; filename: string; mimeType: string }>;
}
