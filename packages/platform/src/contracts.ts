import { z } from "zod";

export const PlatformToolNameSchema = z.enum([
  "estimate_research_scope",
  "search_documents",
  "get_document_metadata",
  "get_relevant_chunks",
  "get_document_text",
  "create_workspace",
  "run_workspace_task",
  "read_workspace_file",
  "destroy_workspace",
]);

export type PlatformToolName = z.infer<typeof PlatformToolNameSchema>;

export const PlatformCitationSchema = z.object({
  documentId: z.string(),
  chunkId: z.string().optional(),
  label: z.string(),
  excerpt: z.string(),
  r2Key: z.string().optional(),
});

export type PlatformCitation = z.infer<typeof PlatformCitationSchema>;

export const DocumentSummarySchema = z.object({
  id: z.string(),
  externalId: z.union([z.string(), z.number()]).nullable().optional(),
  title: z.string(),
  subtitle: z.string().nullable().optional(),
  coverImageUrl: z.string().nullable().optional(),
  hasCoverImage: z.boolean().optional(),
  language: z.string().nullable(),
  publishedAt: z.string().nullable(),
  rightsStatus: z.string().nullable(),
  summary: z.string().nullable(),
  publisher: z.string().nullable().optional(),
  contributors: z.array(z.string()).default([]),
  subjects: z.array(z.string()).default([]),
  score: z.number().optional(),
  metadata: z.record(z.string(), z.unknown()).default({}).optional(),
});

export type DocumentSummary = z.infer<typeof DocumentSummarySchema>;

export const DocumentDetailSchema = DocumentSummarySchema.extend({
  metadata: z.record(z.string(), z.unknown()).default({}),
});

export type DocumentDetail = z.infer<typeof DocumentDetailSchema>;

export const DocumentSourceSchema = z.object({
  format: z.enum(["html", "text"]),
  content: z.string(),
  r2Key: z.string().nullable(),
  sourcePath: z.string().nullable(),
  metadataPath: z.string().nullable(),
});

export type DocumentSource = z.infer<typeof DocumentSourceSchema>;

export const DocumentListResponseSchema = z.object({
  documents: z.array(DocumentSummarySchema),
  nextOffset: z.number().nullable(),
  totalCount: z.number().int().nonnegative(),
});

export type DocumentListResponse = z.infer<typeof DocumentListResponseSchema>;

export const DocumentDetailResponseSchema = z.object({
  document: DocumentDetailSchema,
  source: DocumentSourceSchema.nullable(),
});

export type DocumentDetailResponse = z.infer<typeof DocumentDetailResponseSchema>;

export const DocumentSourceResponseSchema = z.object({
  source: DocumentSourceSchema.nullable(),
});

export type DocumentSourceResponse = z.infer<typeof DocumentSourceResponseSchema>;

export const PlatformChatRequestSchema = z.object({
  sessionId: z.string().uuid().optional(),
  userId: z.string().min(1).optional(),
  message: z.string().min(1),
  documentIds: z.array(z.string()).optional(),
  stream: z.boolean().optional(),
  mode: z.enum(["semantic", "comprehensive"]).optional(),
  intensityOverride: z.enum(["normal", "high", "maximum"]).optional(),
  researchMode: z.enum(["default", "sprite_fanout"]).optional(),
});

export type PlatformChatRequest = z.infer<typeof PlatformChatRequestSchema>;

export const EstimateResearchScopeDocumentArgsSchema = z.object({
  query: z.string().min(1),
  documentIds: z.array(z.string()).max(128).optional(),
  chunkIds: z.array(z.string()).max(512).optional(),
  filters: z
    .object({
      language: z.string().optional(),
      rightsStatus: z.string().optional(),
      yearRange: z.tuple([z.number().int(), z.number().int()]).optional(),
      genre: z.array(z.string().min(1)).max(8).optional(),
    })
    .optional(),
});

export const SearchDocumentsArgsSchema = z.object({
  query: z.string().min(1),
  filters: z
    .object({
      language: z.string().optional(),
      rightsStatus: z.string().optional(),
      yearRange: z.tuple([z.number().int(), z.number().int()]).optional(),
      genre: z.array(z.string().min(1)).max(8).optional(),
      subjects: z.array(z.string()).optional(),
      limit: z.number().int().positive().max(80).optional(),
    })
    .optional(),
});

export const GetDocumentMetadataArgsSchema = z.object({
  documentIds: z.array(z.string()).min(1).max(80),
});

export const GetRelevantDocumentChunksArgsSchema = z.object({
  query: z.string().min(1),
  documentIds: z.array(z.string()).max(80).optional(),
  filters: z
    .object({
      limit: z.number().int().positive().max(3000).optional(),
      language: z.string().optional(),
      rightsStatus: z.string().optional(),
      yearRange: z.tuple([z.number().int(), z.number().int()]).optional(),
      genre: z.array(z.string().min(1)).max(8).optional(),
    })
    .optional(),
});

export const GetDocumentTextArgsSchema = z.object({
  documentId: z.string(),
});

export const CreateDocumentWorkspaceArgsSchema = z.object({
  documentIds: z.array(z.string()).max(20),
  chunkIds: z.array(z.string()).max(100),
  taskContext: z.record(z.string(), z.unknown()).default({}),
});

export const PlatformToolArgsSchemas = {
  estimate_research_scope: EstimateResearchScopeDocumentArgsSchema,
  search_documents: SearchDocumentsArgsSchema,
  get_document_metadata: GetDocumentMetadataArgsSchema,
  get_relevant_chunks: GetRelevantDocumentChunksArgsSchema,
  get_document_text: GetDocumentTextArgsSchema,
  create_workspace: CreateDocumentWorkspaceArgsSchema,
} as const;

export const PlatformToolAliases = {
  search_documents: "search_works",
  get_document_metadata: "get_work_metadata",
  get_document_text: "get_work_text",
} as const;

export function toLegacyToolName(toolName: PlatformToolName): string {
  return PlatformToolAliases[toolName as keyof typeof PlatformToolAliases] ?? toolName;
}

export function toPlatformToolName(toolName: string): PlatformToolName | null {
  switch (toolName) {
    case "estimate_research_scope":
    case "create_workspace":
    case "run_workspace_task":
    case "read_workspace_file":
    case "destroy_workspace":
    case "get_relevant_chunks":
      return toolName;
    case "search_works":
      return "search_documents";
    case "get_work_metadata":
      return "get_document_metadata";
    case "get_work_text":
      return "get_document_text";
    default:
      return null;
  }
}

export function toPlatformToolArgs(toolName: string, args: Record<string, unknown>) {
  switch (toolName) {
    case "search_works":
      return SearchDocumentsArgsSchema.parse(args);
    case "get_work_metadata": {
      const { workIds, ...rest } = args;
      return GetDocumentMetadataArgsSchema.parse({
        ...rest,
        documentIds: workIds,
      });
    }
    case "get_work_text": {
      const { workId, ...rest } = args;
      return GetDocumentTextArgsSchema.parse({
        ...rest,
        documentId: workId,
      });
    }
    case "estimate_research_scope": {
      const { workIds, ...rest } = args;
      return EstimateResearchScopeDocumentArgsSchema.parse({
        ...rest,
        documentIds: workIds,
      });
    }
    case "get_relevant_chunks": {
      const { workIds, ...rest } = args;
      return GetRelevantDocumentChunksArgsSchema.parse({
        ...rest,
        documentIds: workIds,
      });
    }
    case "create_workspace": {
      const { workIds, ...rest } = args;
      return CreateDocumentWorkspaceArgsSchema.parse({
        ...rest,
        documentIds: workIds,
      });
    }
    default:
      return PlatformToolArgsSchemas[toPlatformToolName(toolName) as keyof typeof PlatformToolArgsSchemas]?.parse(args) ?? args;
  }
}

export function toLegacyToolArgs(toolName: string, args: Record<string, unknown>) {
  switch (toolName) {
    case "search_documents":
      return SearchDocumentsArgsSchema.parse(args);
    case "get_document_metadata": {
      const { documentIds, ...rest } = args;
      return {
        ...GetDocumentMetadataArgsSchema.parse(args),
        ...rest,
        workIds: documentIds,
      };
    }
    case "get_document_text": {
      const { documentId, ...rest } = args;
      return {
        ...GetDocumentTextArgsSchema.parse(args),
        ...rest,
        workId: documentId,
      };
    }
    case "estimate_research_scope": {
      const { documentIds, ...rest } = args;
      return {
        ...EstimateResearchScopeDocumentArgsSchema.parse(args),
        ...rest,
        workIds: documentIds,
      };
    }
    case "get_relevant_chunks": {
      const { documentIds, ...rest } = args;
      return {
        ...GetRelevantDocumentChunksArgsSchema.parse(args),
        ...rest,
        workIds: documentIds,
      };
    }
    case "create_workspace": {
      const { documentIds, ...rest } = args;
      return {
        ...CreateDocumentWorkspaceArgsSchema.parse(args),
        ...rest,
        workIds: documentIds,
      };
    }
    default:
      return args;
  }
}

export function toPlatformChatRequest(input: {
  sessionId?: string;
  userId?: string;
  message: string;
  workIds?: string[];
  stream?: boolean;
  mode?: "semantic" | "comprehensive";
  intensityOverride?: "normal" | "high" | "maximum";
  researchMode?: "default" | "sprite_fanout";
}) {
  return PlatformChatRequestSchema.parse({
    ...input,
    documentIds: input.workIds,
  });
}

export function toLegacyChatRequest(input: PlatformChatRequest) {
  return {
    ...input,
    workIds: input.documentIds,
  };
}
