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

export const PlatformChatRequestSchema = z.object({
  sessionId: z.string().uuid().optional(),
  userId: z.string().min(1).optional(),
  message: z.string().min(1),
  documentIds: z.array(z.string()).optional(),
  stream: z.boolean().optional(),
  intensityOverride: z.enum(["normal", "high", "maximum"]).optional(),
});

export type PlatformChatRequest = z.infer<typeof PlatformChatRequestSchema>;

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
