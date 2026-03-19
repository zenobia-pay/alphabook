import { readFile } from "node:fs/promises";
import { S3Client, GetObjectCommand, PutObjectCommand } from "@aws-sdk/client-s3";
import { neon } from "@neondatabase/serverless";
import { artifactKeys } from "@alphabook/corpus-core";

type SessionSummary = {
  id: string;
  title?: string | null;
};

type RunRecord = {
  id: string;
  sessionId: string;
  startedAt: string;
};

type RunArtifactRecord = {
  id?: string;
  runtimeId?: string | null;
  r2Key?: string;
  filename: string;
  mimeType: string;
  metadata?: Record<string, unknown>;
  createdAt?: string | null;
  content?: string | null;
};

type LegacyResearchDocumentItem = {
  kind?: unknown;
  text?: unknown;
  citationText?: unknown;
};

type LegacyResearchDocumentSection = {
  title?: unknown;
  summary?: unknown;
  items?: unknown;
};

type LegacyResearchDocumentBundle = {
  sections?: unknown;
  ending?: unknown;
};

function parseDevVars(raw: string) {
  const values = new Map<string, string>();
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) {
      continue;
    }
    const separatorIndex = trimmed.indexOf("=");
    if (separatorIndex === -1) {
      continue;
    }
    const key = trimmed.slice(0, separatorIndex).trim();
    let value = trimmed.slice(separatorIndex + 1).trim();
    if ((value.startsWith("\"") && value.endsWith("\"")) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    values.set(key, value);
  }
  return values;
}

function normalizeText(value: unknown) {
  return typeof value === "string" ? value.replace(/\s+/gu, " ").trim() : "";
}

function renderLegacyResearchDocumentMarkdown(raw: string) {
  const parsed = JSON.parse(raw) as LegacyResearchDocumentBundle;
  const sections = Array.isArray(parsed.sections) ? parsed.sections as LegacyResearchDocumentSection[] : [];
  const lines: string[] = [];

  for (const section of sections) {
    const title = normalizeText(section.title);
    const summary = normalizeText(section.summary);
    const items = Array.isArray(section.items) ? section.items as LegacyResearchDocumentItem[] : [];
    const body: string[] = [];

    if (summary) {
      body.push(summary);
    }

    for (const item of items) {
      const kind = typeof item.kind === "string" ? item.kind : "";
      const text = normalizeText(item.text);
      const citationText = normalizeText(item.citationText);
      if (!text) {
        continue;
      }
      if (kind === "chunk") {
        body.push(`> ${text}`);
        if (citationText) {
          body.push(`Source: ${citationText}`);
        }
        continue;
      }
      if (kind === "book") {
        body.push(`- ${text}`);
        continue;
      }
      body.push(text);
    }

    if (!title || body.length === 0) {
      continue;
    }
    if (lines.length > 0) {
      lines.push("");
    }
    lines.push(`## ${title}`);
    lines.push("");
    lines.push(...body);
  }

  const ending = normalizeText(parsed.ending);
  if (ending) {
    if (lines.length > 0) {
      lines.push("");
    }
    lines.push("## Final Takeaway");
    lines.push("");
    lines.push(ending);
  }

  return lines.join("\n");
}

async function fetchJson<T>(url: string, cookie: string): Promise<T> {
  const response = await fetch(url, {
    headers: {
      cookie,
      accept: "application/json",
    },
  });
  if (!response.ok) {
    throw new Error(`${url} returned ${response.status}`);
  }
  return await response.json() as T;
}

async function readS3Text(client: S3Client, bucket: string, key: string) {
  const response = await client.send(new GetObjectCommand({
    Bucket: bucket,
    Key: key,
  }));
  return await response.Body?.transformToString() ?? "";
}

async function main() {
  const rawDevVars = await readFile(".dev.vars", "utf8");
  const env = parseDevVars(rawDevVars);
  const apiBase = "https://alpha-book.org/api";
  const cookie = env.get("ALPHABOOK_API_SESSION_COOKIE");
  const databaseUrl = env.get("DATABASE_URL");
  const r2Endpoint = env.get("R2_ENDPOINT");
  const r2AccessKeyId = env.get("R2_ACCESS_KEY_ID");
  const r2SecretAccessKey = env.get("R2_SECRET_ACCESS_KEY");
  const bucket = env.get("R2_BUCKET_NAME") ?? "alphabook";
  const limit = Number.parseInt(process.argv.find((value) => value.startsWith("--limit="))?.split("=")[1] ?? "12", 10);

  if (!cookie || !databaseUrl || !r2Endpoint || !r2AccessKeyId || !r2SecretAccessKey) {
    throw new Error("Missing required credentials in .dev.vars.");
  }

  const sql = neon(databaseUrl);
  const s3 = new S3Client({
    region: "auto",
    endpoint: r2Endpoint,
    credentials: {
      accessKeyId: r2AccessKeyId,
      secretAccessKey: r2SecretAccessKey,
    },
  });

  const sessionsPayload = await fetchJson<{ sessions?: SessionSummary[] }>(`${apiBase}/sessions`, cookie);
  const sessions = Array.isArray(sessionsPayload.sessions) ? sessionsPayload.sessions.slice(0, limit) : [];
  const migrated: Array<{ sessionId: string; runId: string; title: string }> = [];

  for (const session of sessions) {
    const runsPayload = await fetchJson<{ runs?: RunRecord[] }>(`${apiBase}/sessions/${encodeURIComponent(session.id)}/runs`, cookie);
    const runs = Array.isArray(runsPayload.runs) ? runsPayload.runs : [];
    for (const run of runs) {
      const logsPayload = await fetchJson<{ artifacts?: RunArtifactRecord[] }>(
        `${apiBase}/sessions/${encodeURIComponent(session.id)}/runs/${encodeURIComponent(run.id)}/logs`,
        cookie,
      );
      const artifacts = Array.isArray(logsPayload.artifacts) ? logsPayload.artifacts : [];
      const markdownArtifact = artifacts.find((artifact) =>
        artifact.metadata?.kind === "research_document" && artifact.filename.endsWith(".md"),
      );
      if (markdownArtifact) {
        continue;
      }
      const legacyArtifact = artifacts.find((artifact) =>
        artifact.metadata?.kind === "research_document"
        && artifact.filename.endsWith(".json")
        && typeof artifact.content === "string"
        && artifact.content.trim().length > 0,
      );
      if (!legacyArtifact?.r2Key || !legacyArtifact.id) {
        continue;
      }

      const rawJson = legacyArtifact.content ?? await readS3Text(s3, bucket, legacyArtifact.r2Key);
      const markdown = renderLegacyResearchDocumentMarkdown(rawJson);
      if (!markdown.trim()) {
        continue;
      }

      const filename = `${run.id}-research-document.md`;
      const r2Key = artifactKeys.sessionArtifact(session.id, filename);
      await s3.send(new PutObjectCommand({
        Bucket: bucket,
        Key: r2Key,
        Body: markdown,
        ContentType: "text/markdown; charset=utf-8",
      }));

      await sql`
        INSERT INTO artifacts (id, session_id, runtime_id, r2_key, filename, mime_type, metadata_json, created_at)
        VALUES (${crypto.randomUUID()}::uuid, ${session.id}::uuid, ${legacyArtifact.runtimeId ?? null}, ${r2Key}, ${filename}, ${"text/markdown"}, ${JSON.stringify({
          kind: "research_document",
          runId: run.id,
          format: "markdown",
          migratedFromArtifactId: legacyArtifact.id,
        })}::jsonb, ${legacyArtifact.createdAt ?? run.startedAt}::timestamptz)
        ON CONFLICT (r2_key) DO UPDATE
        SET mime_type = EXCLUDED.mime_type, metadata_json = EXCLUDED.metadata_json
      `;

      migrated.push({
        sessionId: session.id,
        runId: run.id,
        title: session.title?.trim() || session.id,
      });
    }
  }

  console.log(JSON.stringify({
    migratedCount: migrated.length,
    migrated,
  }, null, 2));
}

await main();
