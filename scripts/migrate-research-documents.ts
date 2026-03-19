import { readFile } from "node:fs/promises";
import { S3Client, GetObjectCommand, PutObjectCommand } from "@aws-sdk/client-s3";
import { neon } from "@neondatabase/serverless";
import { artifactKeys } from "@alphabook/corpus-core";

type RunRecord = {
  id: string;
  sessionId: string;
  startedAt: string;
  title?: string | null;
  userEmail?: string | null;
};

type RunArtifactRecord = {
  id?: string;
  runtimeId?: string | null;
  r2Key?: string;
  filename: string;
  mimeType: string;
  metadata?: Record<string, unknown>;
  createdAt?: string | null;
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

type ToolHistoryEntry = {
  toolName: string;
  rationale?: string;
  args: Record<string, unknown>;
  result: Record<string, unknown>;
  progressDetails?: Array<Record<string, unknown>>;
};

type TargetUser = {
  email: string;
  limit: number;
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

function escapeHtml(value: string) {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function isLowValueSummary(value: string) {
  const normalized = value.trim().toLowerCase();
  if (!normalized) {
    return true;
  }
  return (
    /^\d+(?:\.\d+)?$/u.test(normalized)
    || /^\d+(?:\s+\d+)+$/u.test(normalized)
    || /^\d+(?:\s*[-–]\s*\d+)+$/u.test(normalized)
  );
}

function renderLegacyResearchDocumentHtml(raw: string) {
  const parsed = JSON.parse(raw) as LegacyResearchDocumentBundle;
  const sections = Array.isArray(parsed.sections) ? parsed.sections as LegacyResearchDocumentSection[] : [];
  const html: string[] = [];

  for (const section of sections) {
    const title = normalizeText(section.title);
    const summary = normalizeText(section.summary);
    const items = Array.isArray(section.items) ? section.items as LegacyResearchDocumentItem[] : [];
    const body: string[] = [];

    for (const item of items) {
      const kind = typeof item.kind === "string" ? item.kind : "";
      const text = normalizeText(item.text);
      const citationText = normalizeText(item.citationText);
      if (!text) {
        continue;
      }
      if (kind === "book") {
        body.push(`<p class="assistant-document-entry is-book">- ${escapeHtml(text)}</p>`);
        continue;
      }
      if (kind === "chunk") {
        body.push([
          `<blockquote class="assistant-document-entry is-chunk">`,
          `<p class="assistant-document-quote">${escapeHtml(text)}</p>`,
          citationText
            ? `<footer class="assistant-document-citation">${escapeHtml(`Source: ${citationText}`)}</footer>`
            : "",
          `</blockquote>`,
        ].join(""));
        continue;
      }
      body.push(`<p class="assistant-document-entry">${escapeHtml(text)}</p>`);
    }

    const kicker = summary && !isLowValueSummary(summary)
      ? `<span class="assistant-document-section-kicker">${escapeHtml(summary)}</span>`
      : "";

    if (!title || (body.length === 0 && !kicker)) {
      continue;
    }

    html.push([
      `<details class="assistant-document-section" open>`,
      `<summary class="assistant-document-section-summary">`,
      `<span class="assistant-document-section-title-row">`,
      `<span class="assistant-document-section-title">${escapeHtml(title)}</span>`,
      `</span>`,
      kicker,
      `</summary>`,
      body.length > 0 ? [`<div class="assistant-document-section-body">`, ...body, `</div>`].join("") : "",
      `</details>`,
    ].join(""));
  }

  const ending = normalizeText(parsed.ending);
  if (ending) {
    html.push([
      `<details class="assistant-document-section" open>`,
      `<summary class="assistant-document-section-summary">`,
      `<span class="assistant-document-section-title-row">`,
      `<span class="assistant-document-section-title">Final Takeaway</span>`,
      `</span>`,
      `<span class="assistant-document-section-kicker">What the run found and how it came together.</span>`,
      `</summary>`,
      `<div class="assistant-document-section-body">`,
      `<p class="assistant-document-entry is-log">${escapeHtml(ending)}</p>`,
      `</div>`,
      `</details>`,
    ].join(""));
  }

  return html.join("");
}

function persistedSectionLabel(toolName: string) {
  switch (toolName) {
    case "search_works":
      return "Metadata Search";
    case "estimate_research_scope":
      return "Scope Estimate";
    case "get_relevant_chunks":
      return "Passage Search";
    case "create_workspace":
      return "Research Setup";
    case "run_workspace_task":
      return "Corpus Briefing";
    case "get_work_metadata":
      return "Book Context";
    default:
      return toolName.replace(/_/g, " ");
  }
}

function formatBookLine(title: string, authors: string[]) {
  return authors.length > 0 ? `- ${title} by ${authors.join(", ")}` : `- ${title}`;
}

function parseToolStreamHistory(raw: string) {
  const toolCalls = new Map<string, ToolHistoryEntry>();
  let ending = "";

  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) {
      continue;
    }
    let parsed: { event?: string; payload?: Record<string, unknown> };
    try {
      parsed = JSON.parse(trimmed) as { event?: string; payload?: Record<string, unknown> };
    } catch {
      continue;
    }
    const event = typeof parsed.event === "string" ? parsed.event : "";
    const payload = parsed.payload && typeof parsed.payload === "object"
      ? parsed.payload as Record<string, unknown>
      : {};

    if (event === "assistant.completed" && typeof payload.answer === "string" && payload.answer.trim()) {
      ending = payload.answer.trim();
      continue;
    }

    if (event === "tool.started.raw") {
      const toolCallId = typeof payload.toolCallId === "string" ? payload.toolCallId : null;
      const toolName = typeof payload.toolName === "string" ? payload.toolName : null;
      if (!toolCallId || !toolName) {
        continue;
      }
      toolCalls.set(toolCallId, {
        toolName,
        rationale: typeof payload.rationale === "string" ? payload.rationale : undefined,
        args: payload.args && typeof payload.args === "object" ? payload.args as Record<string, unknown> : {},
        result: {},
        progressDetails: [],
      });
      continue;
    }

    if (event === "tool.progress") {
      const toolCallId = typeof payload.toolCallId === "string" ? payload.toolCallId : null;
      const detail = payload.detail && typeof payload.detail === "object" ? payload.detail as Record<string, unknown> : null;
      if (!toolCallId || !detail || !toolCalls.has(toolCallId)) {
        continue;
      }
      toolCalls.get(toolCallId)!.progressDetails!.push(detail);
      continue;
    }

    if (event === "tool.completed.raw") {
      const toolCallId = typeof payload.toolCallId === "string" ? payload.toolCallId : null;
      if (!toolCallId || !toolCalls.has(toolCallId)) {
        continue;
      }
      toolCalls.get(toolCallId)!.result = payload.result && typeof payload.result === "object"
        ? payload.result as Record<string, unknown>
        : {};
    }
  }

  return {
    toolHistory: [...toolCalls.values()],
    ending,
  };
}

function renderToolHistoryDocumentHtml(toolHistory: ToolHistoryEntry[], ending: string) {
  const sections: string[] = [];

  for (const entry of toolHistory) {
    const summary = normalizeText(entry.rationale);
    const body: string[] = [];

    for (const detail of entry.progressDetails ?? []) {
      const detailType = typeof detail.type === "string" ? detail.type : "";
      if (detailType === "research.work") {
        const title = normalizeText(detail.workTitle ?? detail.title);
        if (!title) {
          continue;
        }
        const authors = Array.isArray(detail.authors)
          ? detail.authors.filter((value): value is string => typeof value === "string" && value.trim().length > 0)
          : [];
        body.push(`<p class="assistant-document-entry is-book">${escapeHtml(formatBookLine(title, authors))}</p>`);
        continue;
      }
      if (detailType === "research.chunk") {
        const excerpt = normalizeText(detail.excerpt).slice(0, 440);
        if (!excerpt) {
          continue;
        }
        const source = normalizeText(detail.workTitle ?? detail.title) || "Source";
        body.push(`<blockquote class="assistant-document-entry is-chunk"><p class="assistant-document-quote">${escapeHtml(excerpt)}</p><footer class="assistant-document-citation">${escapeHtml(`Source: ${source}`)}</footer></blockquote>`);
      }
    }

    if (entry.toolName === "search_works" || entry.toolName === "get_work_metadata") {
      const works = Array.isArray(entry.result.works) ? entry.result.works as Array<Record<string, unknown>> : [];
      for (const work of works) {
        const title = normalizeText(work.title);
        if (!title) {
          continue;
        }
        const authors = Array.isArray(work.authors)
          ? work.authors.filter((value): value is string => typeof value === "string" && value.trim().length > 0)
          : [];
        body.push(`<p class="assistant-document-entry is-book">${escapeHtml(formatBookLine(title, authors))}</p>`);
      }
    }

    if (entry.toolName === "get_relevant_chunks") {
      const chunks = Array.isArray(entry.result.chunks) ? entry.result.chunks as Array<Record<string, unknown>> : [];
      for (const chunk of chunks.slice(0, 12)) {
        const excerpt = normalizeText(chunk.excerpt ?? chunk.text).slice(0, 440);
        if (!excerpt) {
          continue;
        }
        const source = normalizeText(chunk.workTitle ?? chunk.title) || "Source";
        body.push(`<blockquote class="assistant-document-entry is-chunk"><p class="assistant-document-quote">${escapeHtml(excerpt)}</p><footer class="assistant-document-citation">${escapeHtml(`Source: ${source}`)}</footer></blockquote>`);
      }
    }

    if (entry.toolName === "run_workspace_task") {
      const briefing = normalizeText(entry.result.briefing ?? entry.result.answer);
      if (briefing) {
        for (const paragraph of briefing.split(/\n\s*\n/u).map((part) => part.replace(/\s+/gu, " ").trim()).filter(Boolean)) {
          body.push(`<p class="assistant-document-entry is-log">${escapeHtml(paragraph)}</p>`);
        }
      }
    }

    if (entry.toolName === "create_workspace") {
      const manifest = entry.result.manifest && typeof entry.result.manifest === "object"
        ? entry.result.manifest as Record<string, unknown>
        : null;
      const works = Array.isArray(manifest?.works) ? manifest.works as Array<Record<string, unknown>> : [];
      for (const work of works) {
        const title = normalizeText(work.title);
        if (!title) {
          continue;
        }
        const authors = Array.isArray(work.authors)
          ? work.authors.filter((value): value is string => typeof value === "string" && value.trim().length > 0)
          : [];
        body.push(`<p class="assistant-document-entry is-book">${escapeHtml(formatBookLine(title, authors))}</p>`);
      }
    }

    const kicker = summary && !isLowValueSummary(summary)
      ? `<span class="assistant-document-section-kicker">${escapeHtml(summary.endsWith(".") ? summary : `${summary}.`)}</span>`
      : "";
    if (!kicker && body.length === 0) {
      continue;
    }

    sections.push([
      `<details class="assistant-document-section" open>`,
      `<summary class="assistant-document-section-summary">`,
      `<span class="assistant-document-section-title-row">`,
      `<span class="assistant-document-section-title">${escapeHtml(persistedSectionLabel(entry.toolName))}</span>`,
      `</span>`,
      kicker,
      `</summary>`,
      body.length > 0 ? [`<div class="assistant-document-section-body">`, ...body, `</div>`].join("") : "",
      `</details>`,
    ].join(""));
  }

  const normalizedEnding = normalizeText(ending);
  if (normalizedEnding) {
    sections.push([
      `<details class="assistant-document-section" open>`,
      `<summary class="assistant-document-section-summary">`,
      `<span class="assistant-document-section-title-row">`,
      `<span class="assistant-document-section-title">Final Takeaway</span>`,
      `</span>`,
      `<span class="assistant-document-section-kicker">What the run found and how it came together.</span>`,
      `</summary>`,
      `<div class="assistant-document-section-body">`,
      `<p class="assistant-document-entry is-log">${escapeHtml(normalizedEnding)}</p>`,
      `</div>`,
      `</details>`,
    ].join(""));
  }

  return sections.join("");
}

function parseTargetUsers(argv: string[]) {
  return argv
    .filter((value) => value.startsWith("--user="))
    .flatMap((value) => {
      const raw = value.split("=")[1] ?? "";
      const [email, limitRaw] = raw.split(":");
      const normalizedEmail = email?.trim().toLowerCase();
      const limit = Number.parseInt(limitRaw ?? "1", 10);
      if (!normalizedEmail || !Number.isFinite(limit) || limit <= 0) {
        return [];
      }
      return [{ email: normalizedEmail, limit }] satisfies TargetUser[];
    });
}

function parseSessionIds(argv: string[]) {
  return argv
    .filter((value) => value.startsWith("--session="))
    .map((value) => (value.split("=")[1] ?? "").trim())
    .filter((value) => value.length > 0);
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
  const databaseUrl = env.get("DATABASE_URL");
  const r2Endpoint = env.get("R2_ENDPOINT");
  const r2AccessKeyId = env.get("R2_ACCESS_KEY_ID");
  const r2SecretAccessKey = env.get("R2_SECRET_ACCESS_KEY");
  const bucket = env.get("R2_BUCKET_NAME") ?? "alphabook";
  const limit = Number.parseInt(process.argv.find((value) => value.startsWith("--limit="))?.split("=")[1] ?? "12", 10);
  const targetUsers = parseTargetUsers(process.argv.slice(2));
  const targetSessionIds = parseSessionIds(process.argv.slice(2));

  if (!databaseUrl || !r2Endpoint || !r2AccessKeyId || !r2SecretAccessKey) {
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

  let runs: RunRecord[] = [];

  if (targetUsers.length > 0 || targetSessionIds.length > 0) {
    for (const target of targetUsers) {
      const userRuns = await sql`
        with ranked_sessions as (
          select
            cs.id as "sessionId",
            cs.title,
            u.email as "userEmail",
            r.id,
            r.started_at as "startedAt",
            row_number() over (partition by cs.id order by r.started_at desc) as session_run_rank,
            row_number() over (order by r.started_at desc) as overall_rank
          from chat_sessions cs
          join users u on u.id = cs.user_id
          join runs r on r.session_id = cs.id
          where lower(u.email) = ${target.email}
        )
        select id, "sessionId", "startedAt", title, "userEmail"
        from ranked_sessions
        where session_run_rank = 1 and overall_rank <= ${target.limit}
        order by "startedAt" desc
      ` as RunRecord[];
      runs.push(...userRuns);
    }

    if (targetSessionIds.length > 0) {
      const sessionRuns = await sql`
        with ranked_runs as (
          select
            cs.id as "sessionId",
            cs.title,
            u.email as "userEmail",
            r.id,
            r.started_at as "startedAt",
            row_number() over (partition by cs.id order by r.started_at desc) as session_run_rank
          from chat_sessions cs
          join users u on u.id = cs.user_id
          join runs r on r.session_id = cs.id
          where cs.id = any(${targetSessionIds}::uuid[])
        )
        select id, "sessionId", "startedAt", title, "userEmail"
        from ranked_runs
        where session_run_rank = 1
        order by "startedAt" desc
      ` as RunRecord[];
      runs.push(...sessionRuns);
    }
  } else {
    const defaultRuns = await sql`
      with ranked_sessions as (
        select
          cs.id as "sessionId",
          cs.title,
          r.id,
          r.started_at as "startedAt",
          row_number() over (partition by cs.id order by r.started_at desc) as session_run_rank,
          row_number() over (order by r.started_at desc) as overall_rank
        from chat_sessions cs
        join runs r on r.session_id = cs.id
      )
      select id, "sessionId", "startedAt", title
      from ranked_sessions
      where session_run_rank = 1 and overall_rank <= ${limit}
      order by "startedAt" desc
    ` as RunRecord[];
    runs = defaultRuns;
  }

  const dedupedRuns = Array.from(
    new Map(runs.map((run) => [`${run.sessionId}:${run.id}`, run])).values(),
  );

  const migrated: Array<{ sessionId: string; runId: string; title: string; userEmail: string | null }> = [];

  for (const run of dedupedRuns) {
    const artifacts = await sql`
      select
        id,
        runtime_id as "runtimeId",
        r2_key as "r2Key",
        filename,
        mime_type as "mimeType",
        metadata_json as metadata,
        created_at as "createdAt"
      from artifacts
      where session_id = ${run.sessionId}::uuid
        and (
          filename = ${`${run.id}-research-document.html`}
          or filename = ${`${run.id}-research-document.json`}
          or (metadata_json->>'runId') = ${run.id}
        )
      order by created_at desc
    ` as RunArtifactRecord[];

    const htmlArtifact = artifacts.find((artifact) =>
      artifact.metadata?.kind === "research_document" && artifact.filename.endsWith(".html"),
    );
    if (htmlArtifact) {
      continue;
    }

    const legacyArtifact = artifacts.find((artifact) =>
      artifact.metadata?.kind === "research_document"
      && artifact.filename.endsWith(".json"),
    );
    const toolStreamArtifact = artifacts.find((artifact) => artifact.filename === `${run.id}-tool-stream.jsonl`);
    const rawJson = legacyArtifact?.r2Key ? await readS3Text(s3, bucket, legacyArtifact.r2Key) : "";
    const toolStream = toolStreamArtifact?.r2Key ? await readS3Text(s3, bucket, toolStreamArtifact.r2Key) : "";
    const html = rawJson.trim()
      ? renderLegacyResearchDocumentHtml(rawJson)
      : toolStream.trim()
        ? (() => {
            const { toolHistory, ending } = parseToolStreamHistory(toolStream);
            return renderToolHistoryDocumentHtml(toolHistory, ending);
          })()
        : "";
    if (!html.trim()) {
      continue;
    }

    const filename = `${run.id}-research-document.html`;
    const r2Key = artifactKeys.sessionArtifact(run.sessionId, filename);
    await s3.send(new PutObjectCommand({
      Bucket: bucket,
      Key: r2Key,
      Body: html,
      ContentType: "text/html; charset=utf-8",
    }));

    await sql`
      INSERT INTO artifacts (id, session_id, runtime_id, r2_key, filename, mime_type, metadata_json, created_at)
      VALUES (${crypto.randomUUID()}::uuid, ${run.sessionId}::uuid, ${legacyArtifact?.runtimeId ?? toolStreamArtifact?.runtimeId ?? null}, ${r2Key}, ${filename}, ${"text/html"}, ${JSON.stringify({
        kind: "research_document",
        runId: run.id,
        format: "html",
        ...(legacyArtifact?.id ? { migratedFromArtifactId: legacyArtifact.id } : {}),
        ...(toolStreamArtifact?.id ? { migratedFromToolStreamArtifactId: toolStreamArtifact.id } : {}),
      })}::jsonb, ${legacyArtifact?.createdAt ?? toolStreamArtifact?.createdAt ?? run.startedAt}::timestamptz)
      ON CONFLICT (r2_key) DO UPDATE
      SET mime_type = EXCLUDED.mime_type, metadata_json = EXCLUDED.metadata_json
    `;

    migrated.push({
      sessionId: run.sessionId,
      runId: run.id,
      title: run.title?.trim() || run.sessionId,
      userEmail: run.userEmail ?? null,
    });
  }

  console.log(JSON.stringify({
    migratedCount: migrated.length,
    targetedRuns: dedupedRuns.length,
    migrated,
  }, null, 2));
}

await main();
