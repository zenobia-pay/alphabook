import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

import { createWranglerD1Db, loadLocalDevVars } from "@alphabook/db";

import type { BenchmarkCorpus } from "@alphabook/benchmark-core";

import { loadDotEnvFile } from "./lib/benchmark-env";

interface ScriptOptions {
  outputPath: string;
  sampleSize: number;
  seed: string;
  terms: string[];
}

function parseArgs(argv: string[]): ScriptOptions {
  const options: ScriptOptions = {
    outputPath: "output/benchmark-samples/grief-topical-10-books.json",
    sampleSize: 10,
    seed: "grief-topical-v1",
    terms: ["grief", "mourning", "bereavement", "lament", "sorrow", "death", "loss", "funeral"],
  };

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    switch (argument) {
      case "--output":
        options.outputPath = argv[++index] ?? options.outputPath;
        break;
      case "--sample-size":
        options.sampleSize = Number(argv[++index] ?? options.sampleSize);
        break;
      case "--seed":
        options.seed = argv[++index] ?? options.seed;
        break;
      case "--terms":
        options.terms = (argv[++index] ?? "")
          .split(",")
          .map((term) => term.trim())
          .filter(Boolean);
        break;
      case "--help":
      case "-h":
        process.stdout.write(
          "Usage: node --import tsx packages/tooling/scripts/export-topical-benchmark-sample.ts [--sample-size 10] [--terms grief,mourning,...] [--seed text] [--output path]\n",
        );
        process.exit(0);
        break;
      default:
        throw new Error(`Unknown argument: ${argument}`);
    }
  }

  if (!Number.isFinite(options.sampleSize) || options.sampleSize <= 0) {
    throw new Error(`Invalid --sample-size value: ${options.sampleSize}`);
  }
  if (options.terms.length === 0) {
    throw new Error("At least one search term is required.");
  }

  return options;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  await loadDotEnvFile();
  await loadLocalDevVars(process.cwd());
  const db = createWranglerD1Db({
    cwd: process.cwd(),
    databaseName: process.env.D1_DATABASE_NAME ?? "alphabook-app",
    wranglerConfig: process.env.D1_WRANGLER_CONFIG ?? "ops/cloudflare/resources.toml",
  });
  const whereClause = options.terms
    .map((term) => {
      const escaped = term.toLowerCase().replace(/'/gu, "''");
      return `lower(c.text) like '%${escaped}%'`;
    })
    .join(" OR ");

  const works = await db.query<Record<string, unknown>>(
    `
      with topical_works as (
        select distinct
          w.id,
          w.title,
          w.summary,
          w.language,
          w.release_date,
          w.rights_status,
          w.metadata_json,
          json_group_array(distinct s.label) as subjects_json
        from works w
        left join work_subjects ws on ws.work_id = w.id
        left join subjects s on s.id = ws.subject_id
        where exists (
          select 1
          from chunks c
          where c.work_id = w.id
            and (${whereClause})
        )
        group by w.id, w.title, w.summary, w.language, w.release_date, w.rights_status, w.metadata_json
      )
      select *
      from topical_works
      order by abs(random())
      limit $1
    `,
    [Math.trunc(options.sampleSize)],
  );

  const documentsById = new Map<string, BenchmarkCorpus["documents"][number]>();
  for (const row of works.rows) {
    const workId = String(row.id);
    documentsById.set(workId, {
      id: workId,
      title: String(row.title ?? ""),
      summary: typeof row.summary === "string" ? row.summary : null,
      language: typeof row.language === "string" ? row.language : null,
      publishedAt: row.release_date ? String(row.release_date) : null,
      rightsStatus: typeof row.rights_status === "string" ? row.rights_status : null,
      contributors: [],
      subjects: (() => {
        if (Array.isArray(row.subjects_json)) {
          return row.subjects_json.map((subject) => String(subject));
        }
        if (typeof row.subjects_json === "string") {
          try {
            const parsed = JSON.parse(row.subjects_json) as unknown;
            return Array.isArray(parsed) ? parsed.filter((subject): subject is string => typeof subject === "string") : [];
          } catch {
            return [];
          }
        }
        return [];
      })(),
      metadata: (row.metadata_json as Record<string, unknown> | null) ?? {},
    });
  }

  const workIds = Array.from(documentsById.keys());
  const passages: BenchmarkCorpus["passages"] = [];
  const chunkBatchSize = 10;
  for (let index = 0; index < workIds.length; index += chunkBatchSize) {
    const batchIds = workIds.slice(index, index + chunkBatchSize);
    const batchLiteral = batchIds.map((id) => `'${id.replace(/'/gu, "''")}'`).join(", ");
    const chunkRows = await db.query<Record<string, unknown>>(
      `
        select
          c.work_id,
          c.id as chunk_id,
          c.chunk_index,
          c.text,
          c.metadata_json as chunk_metadata_json
        from chunks c
        where c.work_id in (${batchLiteral})
        order by c.work_id, c.chunk_index
      `
    );

    for (const row of chunkRows.rows) {
      const text = String(row.text ?? "");
      passages.push({
        id: String(row.chunk_id),
        documentId: String(row.work_id),
        chunkIndex: Number(row.chunk_index ?? 0),
        text,
        excerpt: text.slice(0, 280),
        metadata: (row.chunk_metadata_json as Record<string, unknown> | null) ?? {},
      });
    }
  }

  const corpus: BenchmarkCorpus = {
    id: `topical-${options.sampleSize}-books`,
    displayName: `Topical ${options.sampleSize}-book sample`,
    description: `Topical benchmark sample exported from AlphaBook using terms: ${options.terms.join(", ")}.`,
    documents: Array.from(documentsById.values()),
    passages,
  };

  const destination = path.resolve(process.cwd(), options.outputPath);
  await mkdir(path.dirname(destination), { recursive: true });
  await writeFile(destination, JSON.stringify(corpus, null, 2));

  process.stdout.write(`${JSON.stringify({
    outputPath: destination,
    documentCount: corpus.documents.length,
    passageCount: corpus.passages.length,
    terms: options.terms,
  }, null, 2)}\n`);
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
  process.exitCode = 1;
});
