#!/usr/bin/env node

import process from "node:process";

import { Pool } from "@neondatabase/serverless";

function parseArgs(argv) {
  const args = {
    _: [],
    pattern: "",
    query: "",
    language: "",
    title: "",
    works: [],
    chunkIds: [],
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

  return args;
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

function matchExcerpt(text, pattern, ignoreCase) {
  try {
    const regex = new RegExp(pattern, ignoreCase ? "i" : "");
    const match = text.match(regex);
    if (!match || typeof match.index !== "number") {
      return text.slice(0, 420);
    }
    const start = Math.max(0, match.index - 120);
    const end = Math.min(text.length, match.index + (match[0]?.length ?? 0) + 240);
    return text.slice(start, end);
  } catch {
    return text.slice(0, 420);
  }
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
  if (options.title) {
    clauses.push(`w.title ${options.ignoreCase ? "~*" : "~"} $${param}`);
    params.push(options.title);
    param += 1;
  }
  if (!options.invertMatch && literals.length > 0) {
    clauses.push(`
      EXISTS (
        SELECT 1
        FROM unnest($${param}::text[]) AS hint(term)
        WHERE c.text ILIKE '%' || hint.term || '%'
      )
    `);
    params.push(literals);
    param += 1;
  }

  return {
    where: clauses.length > 0 ? clauses.join("\n          AND ") : "TRUE",
    params,
    nextParam: param,
  };
}

async function runRg(client, options) {
  const pattern = options.pattern || options.query || options._[1] || options._[0] || "";
  if (!pattern) {
    throw new Error("rg requires a pattern.");
  }

  const regex = normalizePattern(pattern, options.ignoreCase);
  const literals = extractLiteralHints(pattern);
  const filter = buildChunkFilterWhere(options, literals);
  const operator = options.invertMatch ? "!~" : "~";
  const effectiveLimit = options.maxCount ?? options.limit;
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
          w.language
        FROM chunks c
        JOIN works w ON w.id = c.work_id
        WHERE ${filter.where}
      )
      SELECT
        id,
        work_id,
        chunk_index,
        title,
        language,
        r2_key,
        left(text, 4000) AS text
      FROM filtered_chunks
      WHERE text ${operator} $${filter.nextParam}
      ORDER BY work_id, chunk_index
      LIMIT $${filter.nextParam + 1}
      OFFSET $${filter.nextParam + 2}
    `,
    [
      ...filter.params,
      regex,
      effectiveLimit,
      options.offset,
    ],
  );

  const hits = rows.rows.map((row) => ({
    chunkId: row.id,
    workId: row.work_id,
    chunkIndex: row.chunk_index,
    title: row.title,
    language: row.language,
    r2Key: row.r2_key,
    text: row.text,
    excerpt: matchExcerpt(row.text, pattern, options.ignoreCase),
    label: `${row.work_id}#${row.chunk_index}`,
  }));

  let contextRows = [];
  if ((options.before > 0 || options.after > 0) && hits.length > 0) {
    const hitChunkIds = hits.map((hit) => hit.chunkId);
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
      text: row.text,
      label: `${row.work_id}#${row.chunk_index}`,
      isMatch: hitChunkIds.includes(row.id),
    }));
  }

  const workMap = new Map();
  for (const hit of hits) {
    if (!workMap.has(hit.workId)) {
      workMap.set(hit.workId, {
        workId: hit.workId,
        title: hit.title,
        language: hit.language,
        matchCount: 0,
      });
    }
    workMap.get(hit.workId).matchCount += 1;
  }

  return {
    mode: "rg",
    pattern,
    ignoreCase: options.ignoreCase,
    invertMatch: options.invertMatch,
    literalHints: literals,
    count: hits.length,
    works: [...workMap.values()],
    hits,
    context: contextRows,
  };
}

async function runWorks(client, options) {
  const query = options.query || options.pattern || options._[1] || options._[0] || "";
  if (!query) {
    throw new Error("works requires a query.");
  }

  const rows = await client.query(
    `
      WITH query_input AS (
        SELECT websearch_to_tsquery('english', $1) AS tsq
      )
      SELECT
        w.id,
        w.title,
        w.language,
        w.summary,
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
      ORDER BY score DESC, w.title ASC
      LIMIT $2
    `,
    [query, options.limit],
  );

  return {
    mode: "works",
    query,
    count: rows.rows.length,
    works: rows.rows.map((row) => ({
      workId: row.id,
      title: row.title,
      language: row.language,
      summary: row.summary,
      score: row.score,
    })),
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
    hits: rows.rows.map((row) => ({
      chunkId: row.id,
      workId: row.work_id,
      chunkIndex: row.chunk_index,
      title: row.title,
      r2Key: row.r2_key,
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
      process.stdout.write(`${work.workId}\t${work.title ?? ""}\n`);
    }
    return;
  }

  if (result.mode === "rg" && Array.isArray(result.context) && result.context.length > 0) {
    const matchIds = new Set(result.hits.map((hit) => hit.chunkId));
    let lastWorkId = "";
    for (const row of result.context) {
      if (options.heading && row.workId !== lastWorkId) {
        if (lastWorkId) {
          process.stdout.write("--\n");
        }
        process.stdout.write(`${row.workId}\t${row.title ?? ""}\n`);
      }
      lastWorkId = row.workId;
      const marker = matchIds.has(row.chunkId) ? ":" : "-";
      process.stdout.write(`${formatHit(row, options, marker)}\n`);
    }
    return;
  }

  const rows = Array.isArray(result.hits) ? result.hits : [];
  for (const row of rows) {
    process.stdout.write(`${formatHit(row, options)}\n`);
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
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
    process.stdout.write(JSON.stringify(result, null, 2));
    return;
  }

  printText(result, args);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack || error.message : String(error));
  process.exit(1);
});
