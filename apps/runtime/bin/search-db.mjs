#!/usr/bin/env node

import process from "node:process";
import { pathToFileURL } from "node:url";

import { Pool } from "@neondatabase/serverless";

export function parseArgs(argv) {
  const args = {
    _: [],
    pattern: "",
    query: "",
    language: "",
    title: "",
    yearFrom: null,
    yearTo: null,
    works: [],
    chunkIds: [],
    globs: [],
    kinds: [],
    limit: 100,
    offset: 0,
    before: 0,
    after: 0,
    radius: 2,
    maxCount: null,
    json: false,
    ignoreCase: false,
    invertMatch: false,
    countOnly: false,
    filesWithMatches: false,
    field: "excerpt",
    heading: false,
    noFilename: false,
    multiline: false,
    window: 0,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const next = argv[index + 1];

    if (!arg.startsWith("-")) {
      args._.push(arg);
      continue;
    }

    if (arg === "-i" || arg === "--ignore-case") {
      args.ignoreCase = true;
      continue;
    }
    if (arg === "-v" || arg === "--invert-match") {
      args.invertMatch = true;
      continue;
    }
    if (arg === "-c" || arg === "--count") {
      args.countOnly = true;
      continue;
    }
    if (arg === "-l" || arg === "--files-with-matches") {
      args.filesWithMatches = true;
      continue;
    }
    if (arg === "-n" || arg === "--line-number") {
      continue;
    }
    if (arg === "--json") {
      args.json = true;
      continue;
    }
    if (arg === "--heading") {
      args.heading = true;
      continue;
    }
    if (arg === "--no-filename") {
      args.noFilename = true;
      continue;
    }
    if (arg === "-U" || arg === "--multiline") {
      args.multiline = true;
      continue;
    }
    if (arg === "-A" || arg === "--after-context") {
      args.after = Math.max(0, Number.parseInt(next ?? "0", 10) || 0);
      index += 1;
      continue;
    }
    if (arg === "-B" || arg === "--before-context") {
      args.before = Math.max(0, Number.parseInt(next ?? "0", 10) || 0);
      index += 1;
      continue;
    }
    if (arg === "-C" || arg === "--context") {
      const value = Math.max(0, Number.parseInt(next ?? "0", 10) || 0);
      args.before = value;
      args.after = value;
      args.radius = value;
      index += 1;
      continue;
    }
    if (arg === "-m" || arg === "--max-count") {
      args.maxCount = Math.max(1, Number.parseInt(next ?? "1", 10) || 1);
      index += 1;
      continue;
    }
    if (arg === "--limit") {
      args.limit = Math.max(1, Math.min(1000, Number.parseInt(next ?? "100", 10) || 100));
      index += 1;
      continue;
    }
    if (arg === "--offset") {
      args.offset = Math.max(0, Number.parseInt(next ?? "0", 10) || 0);
      index += 1;
      continue;
    }
    if (arg === "--radius") {
      args.radius = Math.max(0, Math.min(12, Number.parseInt(next ?? "2", 10) || 2));
      index += 1;
      continue;
    }
    if (arg === "--window") {
      args.window = Math.max(0, Math.min(8, Number.parseInt(next ?? "0", 10) || 0));
      index += 1;
      continue;
    }
    if (arg === "--pattern") {
      args.pattern = next ?? "";
      index += 1;
      continue;
    }
    if (arg === "--query") {
      args.query = next ?? "";
      index += 1;
      continue;
    }
    if (arg === "--language") {
      args.language = next ?? "";
      index += 1;
      continue;
    }
    if (arg === "--title") {
      args.title = next ?? "";
      index += 1;
      continue;
    }
    if (arg === "--year-from") {
      args.yearFrom = Number.parseInt(next ?? "", 10) || null;
      index += 1;
      continue;
    }
    if (arg === "--year-to") {
      args.yearTo = Number.parseInt(next ?? "", 10) || null;
      index += 1;
      continue;
    }
    if (arg === "--glob" || arg === "-g") {
      if (next) {
        args.globs.push(next);
        index += 1;
      }
      continue;
    }
    if (arg === "--kind") {
      if (next) {
        args.kinds.push(next);
        index += 1;
      }
      continue;
    }
    if (arg === "--work") {
      if (next) {
        args.works.push(next);
        index += 1;
      }
      continue;
    }
    if (arg === "--chunk-id") {
      if (next) {
        args.chunkIds.push(next);
        index += 1;
      }
      continue;
    }
    if (arg === "--field") {
      args.field = next === "text" ? "text" : "excerpt";
      index += 1;
      continue;
    }

    args._.push(arg);
  }

  if (args.multiline && args.window === 0) {
    args.window = 1;
  }

  args.kinds = normalizeKinds(args.kinds);

  return args;
}

function writeStdout(text) {
  try {
    process.stdout.write(text);
    return true;
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "EPIPE") {
      return false;
    }
    throw error;
  }
}

function writeProgressMarker(payload) {
  try {
    process.stderr.write(`ALPHABOOK_PROGRESS ${JSON.stringify(payload)}\n`);
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "EPIPE") {
      return;
    }
    throw error;
  }
}

function normalizeKinds(kinds) {
  const aliasMap = new Map([
    ["clean_text", "clean"],
    ["clean", "clean"],
    ["chunks_jsonl", "chunks"],
    ["chunk_jsonl", "chunks"],
    ["chunks", "chunks"],
    ["raw_text", "raw"],
    ["raw", "raw"],
    ["metadata_json", "metadata"],
    ["metadata", "metadata"],
    ["cover_image", "cover"],
    ["cover", "cover"],
  ]);

  return Array.from(
    new Set(
      kinds
        .map((kind) => String(kind || "").trim().toLowerCase())
        .filter(Boolean)
        .map((kind) => aliasMap.get(kind) ?? kind),
    ),
  );
}

function normalizePattern(pattern, ignoreCase) {
  if (!pattern) {
    return "";
  }
  return ignoreCase ? `(?i)${pattern}` : pattern;
}

function extractLiteralHints(pattern) {
  const matches = pattern.match(/[A-Za-z][A-Za-z0-9']{2,}/g) ?? [];
  return Array.from(new Set(matches.map((token) => token.toLowerCase()))).slice(0, 8);
}

export function globToRegex(glob) {
  let regex = "^";
  for (let index = 0; index < glob.length; index += 1) {
    const char = glob[index];
    if (char === "*") {
      const next = glob[index + 1];
      if (next === "*") {
        regex += ".*";
        index += 1;
      } else {
        regex += "[^/]*";
      }
      continue;
    }
    if (char === "?") {
      regex += ".";
      continue;
    }
    if ("\\.[]{}()+-^$|".includes(char)) {
      regex += `\\${char}`;
      continue;
    }
    regex += char;
  }
  regex += "$";
  return regex;
}

function compileRegex(pattern, ignoreCase, multiline = false) {
  return new RegExp(pattern, `${ignoreCase ? "i" : ""}${multiline ? "ms" : ""}`);
}

function safeRegex(pattern, ignoreCase, multiline = false) {
  try {
    return compileRegex(pattern, ignoreCase, multiline);
  } catch (error) {
    throw new Error(`Invalid regular expression: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function compactWhitespace(text) {
  return text.replace(/\s+/g, " ").trim();
}

function lineColFromIndex(text, index) {
  const safeIndex = Math.max(0, Math.min(text.length, index));
  let line = 1;
  let column = 1;
  for (let i = 0; i < safeIndex; i += 1) {
    if (text[i] === "\n") {
      line += 1;
      column = 1;
    } else {
      column += 1;
    }
  }
  return { line, column };
}

function snippetAround(text, start, end, radius = 180) {
  const from = Math.max(0, start - radius);
  const to = Math.min(text.length, end + radius);
  return text.slice(from, to);
}

function matchSegments(text, regex) {
  const flags = regex.flags.includes("g") ? regex.flags : `${regex.flags}g`;
  const globalRegex = new RegExp(regex.source, flags);
  const segments = [];
  let match;
  while ((match = globalRegex.exec(text)) !== null) {
    const matched = match[0] ?? "";
    const start = match.index ?? 0;
    const end = start + matched.length;
    segments.push({
      text: matched,
      start,
      end,
      ...lineColFromIndex(text, start),
      endLine: lineColFromIndex(text, end).line,
      endColumn: lineColFromIndex(text, end).column,
    });
    if (matched.length === 0) {
      globalRegex.lastIndex += 1;
    }
  }
  return segments;
}

async function withClient(fn) {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    throw new Error("DATABASE_URL is not configured in the runtime.");
  }

  const pool = new Pool({ connectionString });
  const client = await pool.connect();
  try {
    await client.query("BEGIN READ ONLY");
    await client.query("SET LOCAL statement_timeout = '15000ms'");
    const result = await fn(client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    try {
      await client.query("ROLLBACK");
    } catch {
      // Ignore rollback errors.
    }
    throw error;
  } finally {
    client.release();
    await pool.end();
  }
}

function buildChunkFilterWhere(options, literals, startParam = 1) {
  const clauses = [];
  const params = [];
  let param = startParam;

  if (options.works.length > 0) {
    clauses.push(`c.work_id = ANY($${param}::uuid[])`);
    params.push(options.works);
    param += 1;
  }
  if (options.language) {
    clauses.push(`w.language = $${param}`);
    params.push(options.language);
    param += 1;
  }
  if (typeof options.yearFrom === "number") {
    clauses.push(`w.release_date >= make_date($${param}, 1, 1)`);
    params.push(options.yearFrom);
    param += 1;
  }
  if (typeof options.yearTo === "number") {
    clauses.push(`w.release_date <= make_date($${param}, 12, 31)`);
    params.push(options.yearTo);
    param += 1;
  }
  if (options.title) {
    clauses.push(`w.title ${options.ignoreCase ? "~*" : "~"} $${param}`);
    params.push(options.title);
    param += 1;
  }
  if (options.kinds.length > 0) {
    clauses.push(`
      EXISTS (
        SELECT 1
        FROM work_files wf_kind
        WHERE wf_kind.work_id = c.work_id
          AND wf_kind.kind = ANY($${param}::text[])
      )
    `);
    params.push(options.kinds);
    param += 1;
  }
  if (options.globs.length > 0) {
    clauses.push(`
      EXISTS (
        SELECT 1
        FROM work_files wf_glob
        WHERE wf_glob.work_id = c.work_id
          AND wf_glob.r2_key IS NOT NULL
          AND wf_glob.r2_key ~ ANY($${param}::text[])
      )
    `);
    params.push(options.globs.map(globToRegex));
    param += 1;
  }
  if (!options.invertMatch && literals.length > 0) {
    clauses.push(`c.tsv @@ websearch_to_tsquery('english', $${param})`);
    params.push(literals.join(" OR "));
    param += 1;
  }

  return {
    where: clauses.length > 0 ? clauses.join("\n          AND ") : "TRUE",
    params,
    nextParam: param,
  };
}

function groupByWork(rows) {
  const byWork = new Map();
  for (const row of rows) {
    const workId = String(row.work_id);
    const existing = byWork.get(workId) ?? [];
    existing.push(row);
    byWork.set(workId, existing);
  }
  for (const rowsForWork of byWork.values()) {
    rowsForWork.sort((left, right) => Number(left.chunk_index) - Number(right.chunk_index));
  }
  return byWork;
}

function buildWindow(rowsForWork, index, windowRadius) {
  const startIndex = Math.max(0, index - windowRadius);
  const endIndex = Math.min(rowsForWork.length - 1, index + windowRadius);
  const windowRows = rowsForWork.slice(startIndex, endIndex + 1);
  const joiner = "\n";
  let cursor = 0;
  const pieces = [];
  const rowOffsets = [];
  for (const row of windowRows) {
    const text = String(row.text ?? "");
    const start = cursor;
    const end = start + text.length;
    rowOffsets.push({
      chunkId: row.id,
      chunkIndex: row.chunk_index,
      start,
      end,
    });
    pieces.push(text);
    cursor = end + joiner.length;
  }
  return {
    windowRows,
    text: pieces.join(joiner),
    rowOffsets,
    startChunkIndex: windowRows[0]?.chunk_index ?? null,
    endChunkIndex: windowRows.at(-1)?.chunk_index ?? null,
  };
}

function findPrimaryChunkId(rowOffsets, matchStart, fallbackChunkId) {
  for (const row of rowOffsets) {
    if (matchStart >= row.start && matchStart <= row.end) {
      return row.chunkId;
    }
  }
  return fallbackChunkId;
}

function formatRgHit({
  row,
  work,
  pattern,
  regex,
  options,
  window,
}) {
  const segments = matchSegments(window.text, regex);
  const matches = options.invertMatch ? [] : segments;
  const primaryMatch = matches[0] ?? null;
  const excerpt = primaryMatch
    ? snippetAround(window.text, primaryMatch.start, primaryMatch.end, 180)
    : compactWhitespace(window.text).slice(0, 420);

  return {
    chunkId: row.id,
    primaryChunkId: findPrimaryChunkId(window.rowOffsets, primaryMatch?.start ?? 0, row.id),
    workId: row.work_id,
    chunkIndex: row.chunk_index,
    title: row.title,
    language: row.language,
    gutenbergId: work?.gutenberg_id ?? null,
    releaseDate: work?.release_date ?? null,
    rightsStatus: work?.rights_status ?? null,
    summary: work?.summary ?? null,
    r2Key: row.r2_key,
    sourcePath: row.clean_text_key ?? row.r2_key ?? null,
    text: window.text,
    excerpt,
    label: `${row.work_id}#${row.chunk_index}`,
    matchCount: matches.length,
    matches,
    literalHints: extractLiteralHints(pattern),
    windowStartChunkIndex: window.startChunkIndex,
    windowEndChunkIndex: window.endChunkIndex,
    matchedChunkIds: window.windowRows.map((item) => item.id),
    fileKinds: Array.isArray(row.file_kinds) ? row.file_kinds : [],
  };
}

async function runRg(client, options) {
  const pattern = options.pattern || options.query || options._[1] || options._[0] || "";
  if (!pattern) {
    throw new Error("rg requires a pattern.");
  }

  const regex = safeRegex(pattern, options.ignoreCase, options.multiline);
  const sqlRegex = normalizePattern(pattern, options.ignoreCase);
  const literals = extractLiteralHints(pattern);
  const filter = buildChunkFilterWhere(options, literals);
  const operator = options.invertMatch ? "!~" : "~";
  const effectiveLimit = options.maxCount ?? options.limit;
  const widenedLimit = Math.min(Math.max((effectiveLimit + options.offset) * (options.window > 0 ? 6 : 3), 200), 4000);

  const rows = await client.query(
    `
      WITH filtered_chunks AS (
        SELECT
          c.id,
          c.work_id,
          c.chunk_index,
          c.text,
          c.r2_key,
          w.title,
          w.language,
          w.gutenberg_id,
          w.release_date,
          w.rights_status,
          w.summary,
          clean_file.r2_key AS clean_text_key,
          ARRAY_REMOVE(ARRAY_AGG(DISTINCT wf.kind), NULL) AS file_kinds
        FROM chunks c
        JOIN works w ON w.id = c.work_id
        LEFT JOIN work_files wf ON wf.work_id = c.work_id
        LEFT JOIN work_files clean_file
          ON clean_file.work_id = c.work_id
         AND clean_file.kind = 'clean'
        WHERE ${filter.where}
        GROUP BY c.id, w.id, clean_file.r2_key
      )
      SELECT
        id,
        work_id,
        chunk_index,
        title,
        language,
        gutenberg_id,
        release_date,
        rights_status,
        summary,
        r2_key,
        clean_text_key,
        file_kinds,
        left(text, 4000) AS text
      FROM filtered_chunks
      WHERE text ${operator} $${filter.nextParam}
      ORDER BY work_id, chunk_index
      LIMIT $${filter.nextParam + 1}
      OFFSET 0
    `,
    [
      ...filter.params,
      sqlRegex,
      widenedLimit,
    ],
  );

  const byWork = groupByWork(rows.rows);
  const worksById = new Map();
  const candidates = [];
  const seenWindows = new Set();

  for (const row of rows.rows) {
    worksById.set(String(row.work_id), row);
  }

  for (const rowsForWork of byWork.values()) {
    for (let index = 0; index < rowsForWork.length; index += 1) {
      const row = rowsForWork[index];
      const windowRadius = options.multiline || options.window > 0 ? Math.max(options.window, 1) : 0;
      const window = buildWindow(rowsForWork, index, windowRadius);
      const windowKey = `${row.work_id}:${window.startChunkIndex}:${window.endChunkIndex}`;
      if (seenWindows.has(windowKey)) {
        continue;
      }
      const matched = regex.test(window.text);
      regex.lastIndex = 0;
      if (options.invertMatch ? matched : !matched) {
        continue;
      }
      seenWindows.add(windowKey);
      candidates.push(formatRgHit({
        row,
        work: worksById.get(String(row.work_id)),
        pattern,
        regex,
        options,
        window,
      }));
    }
  }

  const hits = candidates.slice(options.offset, options.offset + effectiveLimit);
  const workMap = new Map();
  const touchedWorkMap = new Map();
  for (const hit of hits) {
    if (!workMap.has(hit.workId)) {
      workMap.set(hit.workId, {
        workId: hit.workId,
        title: hit.title,
        language: hit.language,
        gutenbergId: hit.gutenbergId,
        releaseDate: hit.releaseDate,
        matchCount: 0,
      });
    }
    workMap.get(hit.workId).matchCount += 1;
  }
  for (const candidate of candidates) {
    if (!touchedWorkMap.has(candidate.workId)) {
      touchedWorkMap.set(candidate.workId, {
        workId: candidate.workId,
        title: candidate.title,
        language: candidate.language,
        gutenbergId: candidate.gutenbergId,
        releaseDate: candidate.releaseDate,
      });
    }
  }

  let contextRows = [];
  if ((options.before > 0 || options.after > 0) && hits.length > 0) {
    const hitChunkIds = Array.from(new Set(hits.map((hit) => hit.primaryChunkId || hit.chunkId)));
    const context = await client.query(
      `
        WITH seeds AS (
          SELECT id, work_id, chunk_index
          FROM chunks
          WHERE id = ANY($1::uuid[])
        )
        SELECT DISTINCT ON (c.id)
          c.id,
          c.work_id,
          c.chunk_index,
          c.r2_key,
          w.title,
          left(c.text, 2000) AS text
        FROM chunks c
        JOIN seeds s
          ON s.work_id = c.work_id
         AND c.chunk_index BETWEEN s.chunk_index - $2 AND s.chunk_index + $3
        JOIN works w ON w.id = c.work_id
        ORDER BY c.id, c.work_id, c.chunk_index
      `,
      [hitChunkIds, options.before, options.after],
    );
    contextRows = context.rows.map((row) => ({
      chunkId: row.id,
      workId: row.work_id,
      chunkIndex: row.chunk_index,
      title: row.title,
      r2Key: row.r2_key,
      sourcePath: row.r2_key ?? null,
      text: row.text,
      excerpt: row.text,
      label: `${row.work_id}#${row.chunk_index}`,
      isMatch: hitChunkIds.includes(row.id),
    }));
  }

  return {
    mode: "rg",
    pattern,
    ignoreCase: options.ignoreCase,
    invertMatch: options.invertMatch,
    multiline: options.multiline,
    window: options.window,
    literalHints: literals,
    count: hits.length,
    works: [...workMap.values()],
    touchedWorks: [...touchedWorkMap.values()],
    hits,
    context: contextRows,
    filters: {
      workIds: options.works,
      language: options.language || null,
      yearFrom: options.yearFrom,
      yearTo: options.yearTo,
      titleRegex: options.title || null,
      globs: options.globs,
      kinds: options.kinds,
    },
  };
}

async function runWorks(client, options) {
  const query = options.query || options.pattern || options._[1] || options._[0] || "";
  if (!query) {
    throw new Error("works requires a query.");
  }

  const filters = [];
  const params = [query];
  let paramIndex = 2;
  if (options.language) {
    filters.push(`w.language = $${paramIndex}`);
    params.push(options.language);
    paramIndex += 1;
  }
  if (typeof options.yearFrom === "number") {
    filters.push(`w.release_date >= make_date($${paramIndex}, 1, 1)`);
    params.push(options.yearFrom);
    paramIndex += 1;
  }
  if (typeof options.yearTo === "number") {
    filters.push(`w.release_date <= make_date($${paramIndex}, 12, 31)`);
    params.push(options.yearTo);
    paramIndex += 1;
  }
  const rows = await client.query(
    `
      WITH query_input AS (
        SELECT websearch_to_tsquery('english', $1) AS tsq
      )
      SELECT
        w.id,
        w.gutenberg_id,
        w.title,
        w.language,
        w.summary,
        w.release_date,
        ts_rank_cd(
          setweight(to_tsvector('english', COALESCE(w.title, '')), 'A') ||
          setweight(to_tsvector('english', COALESCE(w.summary, '')), 'B'),
          query_input.tsq
        ) AS score
      FROM works w
      CROSS JOIN query_input
      WHERE (
        setweight(to_tsvector('english', COALESCE(w.title, '')), 'A') ||
        setweight(to_tsvector('english', COALESCE(w.summary, '')), 'B')
      ) @@ query_input.tsq
      ${filters.length > 0 ? `AND ${filters.join("\n      AND ")}` : ""}
      ORDER BY score DESC, w.title ASC
      LIMIT $${paramIndex}
    `,
    [...params, options.limit],
  );

  return {
    mode: "works",
    query,
    count: rows.rows.length,
    works: rows.rows.map((row) => ({
      workId: row.id,
      gutenbergId: row.gutenberg_id,
      title: row.title,
      language: row.language,
      summary: row.summary,
      releaseDate: row.release_date,
      score: row.score,
    })),
    touchedWorks: rows.rows.map((row) => ({
      workId: row.id,
      title: row.title,
      language: row.language,
      summary: row.summary,
      releaseDate: row.release_date,
    })),
    filters: {
      language: options.language || null,
      yearFrom: options.yearFrom,
      yearTo: options.yearTo,
    },
  };
}

async function runNeighbors(client, options) {
  if (options.chunkIds.length === 0) {
    throw new Error("neighbors requires at least one --chunk-id.");
  }

  const rows = await client.query(
    `
      WITH seeds AS (
        SELECT id, work_id, chunk_index
        FROM chunks
        WHERE id = ANY($1::uuid[])
      )
      SELECT
        c.id,
        c.work_id,
        c.chunk_index,
        c.r2_key,
        w.title,
        w.gutenberg_id,
        left(c.text, 4000) AS text
      FROM chunks c
      JOIN seeds s
        ON s.work_id = c.work_id
       AND c.chunk_index BETWEEN s.chunk_index - $2 AND s.chunk_index + $2
      JOIN works w ON w.id = c.work_id
      ORDER BY c.work_id, c.chunk_index
    `,
    [options.chunkIds, options.radius],
  );

  return {
    mode: "neighbors",
    chunkIds: options.chunkIds,
    radius: options.radius,
    count: rows.rows.length,
    touchedWorks: Array.from(
      new Map(
        rows.rows.map((row) => [
          String(row.work_id),
          {
            workId: row.work_id,
            title: row.title,
            gutenbergId: row.gutenberg_id,
          },
        ]),
      ).values(),
    ),
    hits: rows.rows.map((row) => ({
      chunkId: row.id,
      workId: row.work_id,
      gutenbergId: row.gutenberg_id,
      chunkIndex: row.chunk_index,
      title: row.title,
      r2Key: row.r2_key,
      sourcePath: row.r2_key ?? null,
      text: row.text,
      excerpt: row.text.slice(0, 420),
      label: `${row.work_id}#${row.chunk_index}`,
    })),
  };
}

async function runCat(client, options) {
  if (options.chunkIds.length > 0) {
    return runNeighbors(client, options);
  }

  const rgResult = await runRg(client, {
    ...options,
    limit: options.limit,
    before: options.before,
    after: options.after,
  });

  return {
    mode: "cat",
    pattern: rgResult.pattern,
    count: rgResult.context.length > 0 ? rgResult.context.length : rgResult.hits.length,
    hits: rgResult.context.length > 0 ? rgResult.context : rgResult.hits,
  };
}

function formatHit(hit, options, marker = ":") {
  const prefix = options.noFilename ? "" : `${hit.label}${hit.title ? `:${hit.title}` : ""}`;
  const body = options.field === "text"
    ? (hit.text ?? hit.excerpt ?? "")
    : (hit.excerpt ?? hit.text ?? "");
  return prefix ? `${prefix}${marker}${body}` : body;
}

function emitProgressMarkers(result) {
  if (!result || typeof result !== "object") {
    return;
  }

  const mode = typeof result.mode === "string" ? result.mode : "unknown";
  const touchedWorks = Array.isArray(result.touchedWorks)
    ? result.touchedWorks.filter((value) => value && typeof value === "object")
    : Array.isArray(result.works)
      ? result.works.filter((value) => value && typeof value === "object")
      : [];
  for (const work of touchedWorks) {
    const record = work;
    const workId =
      typeof record.workId === "string" ? record.workId
      : typeof record.id === "string" ? record.id
      : null;
    if (!workId) {
      continue;
    }
    writeProgressMarker({
      type: "research.work",
      source: `runtime.${mode}`,
      workId,
      workTitle:
        typeof record.title === "string" ? record.title
        : typeof record.workTitle === "string" ? record.workTitle
        : workId,
      ...(Array.isArray(record.authors) ? { authors: record.authors } : {}),
      ...(typeof record.releaseDate === "string" ? { releaseDate: record.releaseDate } : {}),
      ...(typeof record.summary === "string" ? { summary: record.summary } : {}),
    });
  }

  const touchedChunks = Array.isArray(result.hits)
    ? result.hits.filter((value) => value && typeof value === "object")
    : [];
  for (const chunk of touchedChunks) {
    const record = chunk;
    const workId = typeof record.workId === "string" ? record.workId : null;
    if (!workId) {
      continue;
    }
    writeProgressMarker({
      type: "research.chunk",
      source: `runtime.${mode}`,
      workId,
      ...(typeof record.chunkId === "string" ? { chunkId: record.chunkId } : {}),
      ...(typeof record.chunkIndex === "number" ? { chunkIndex: record.chunkIndex } : {}),
      workTitle:
        typeof record.title === "string" ? record.title
        : typeof record.workTitle === "string" ? record.workTitle
        : workId,
      excerpt:
        typeof record.excerpt === "string" ? record.excerpt
        : typeof record.text === "string" ? record.text.slice(0, 420)
        : "",
      ...(typeof record.r2Key === "string" ? { r2Key: record.r2Key } : {}),
    });
  }
}

function printText(result, options) {
  if (result.mode === "works") {
    for (const work of result.works) {
      process.stdout.write(`${work.workId}\t${work.title}${work.language ? `\t${work.language}` : ""}\n`);
    }
    return;
  }

  if (options.countOnly) {
    process.stdout.write(`${result.count}\n`);
    return;
  }

  if (options.filesWithMatches) {
    for (const work of result.works ?? []) {
      if (!writeStdout(`${work.workId}\t${work.title ?? ""}\n`)) {
        return;
      }
    }
    return;
  }

  if (result.mode === "rg" && Array.isArray(result.context) && result.context.length > 0) {
    const matchIds = new Set(result.hits.map((hit) => hit.primaryChunkId ?? hit.chunkId));
    let lastWorkId = "";
    for (const row of result.context) {
      if (options.heading && row.workId !== lastWorkId) {
        if (lastWorkId) {
          if (!writeStdout("--\n")) {
            return;
          }
        }
        if (!writeStdout(`${row.workId}\t${row.title ?? ""}\n`)) {
          return;
        }
      }
      lastWorkId = row.workId;
      const marker = matchIds.has(row.chunkId) ? ":" : "-";
      if (!writeStdout(`${formatHit(row, options, marker)}\n`)) {
        return;
      }
    }
    return;
  }

  const rows = Array.isArray(result.hits) ? result.hits : [];
  for (const row of rows) {
    if (!writeStdout(`${formatHit(row, options)}\n`)) {
      return;
    }
  }
}

export async function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  const command = args._[0] ?? "rg";

  const result = await withClient(async (client) => {
    if (command === "rg" || command === "grep" || command === "regex") {
      return runRg(client, args);
    }
    if (command === "works") {
      return runWorks(client, args);
    }
    if (command === "neighbors") {
      return runNeighbors(client, args);
    }
    if (command === "cat") {
      return runCat(client, args);
    }
    throw new Error(`Unsupported command: ${command}`);
  });

  if (args.json) {
    emitProgressMarkers(result);
    writeStdout(JSON.stringify(result, null, 2));
    return result;
  }

  emitProgressMarkers(result);
  printText(result, args);
  return result;
}

const entryHref = process.argv[1] ? pathToFileURL(process.argv[1]).href : null;

if (entryHref && import.meta.url === entryHref) {
  process.stdout.on("error", (error) => {
    if (error && typeof error === "object" && "code" in error && error.code === "EPIPE") {
      process.exit(0);
    }
    throw error;
  });
  main().catch((error) => {
    console.error(error instanceof Error ? error.stack || error.message : String(error));
    process.exit(1);
  });
}
