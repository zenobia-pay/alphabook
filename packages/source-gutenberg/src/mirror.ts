import { access, readFile, readdir } from "node:fs/promises";
import { basename, join } from "node:path";

export interface MirrorSource {
  gutenbergId: string;
  title: string | null;
  subtitle: string | null;
  authors: string[];
  subjects: string[];
  bookshelves: string[];
  language: string | null;
  releaseDate: string | null;
  rightsStatus: string | null;
  publisher: string | null;
  summary: string | null;
  translators: string[];
  illustrators: string[];
  editors: string[];
  coverImagePath: string | null;
  sourcePath: string;
  metadataPath: string | null;
  format: "text" | "html";
  rawSource: string;
  rawText: string;
  metadata: Record<string, unknown>;
}

function digitsPath(gutenbergId: string): string[] {
  const digits = gutenbergId.replace(/\D+/g, "");
  if (digits.length === 1) {
    return ["0"];
  }
  return digits.length > 1 ? digits.slice(0, -1).split("") : [];
}

export function mainMirrorDirectory(root: string, gutenbergId: string): string {
  return join(root, ...digitsPath(gutenbergId), gutenbergId);
}

export function generatedMirrorDirectory(root: string, gutenbergId: string): string {
  return join(root, "cache", "epub", gutenbergId);
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

async function listFilesRecursive(root: string, maxDepth = 2, currentDepth = 0): Promise<string[]> {
  if (!(await exists(root))) {
    return [];
  }
  const entries = await readdir(root, { withFileTypes: true });
  const files = await Promise.all(
    entries.map(async (entry) => {
      const fullPath = join(root, entry.name);
      if (entry.isDirectory()) {
        if (currentDepth >= maxDepth) {
          return [];
        }
        return listFilesRecursive(fullPath, maxDepth, currentDepth + 1);
      }
      return [fullPath];
    }),
  );
  return files.flat();
}

function extractGutenbergIdFromPath(path: string): string | null {
  const base = basename(path).toLowerCase();
  const match = base.match(/^(\d+)(?:-\d+)?\.(txt|htm|html)(?:\.utf-8)?$/i)
    ?? base.match(/^pg(\d+)(?:-[a-z0-9]+)?\.(txt|htm|html)(?:\.utf-8)?$/i);
  return match?.[1] ?? null;
}

async function listNumericDirectories(root: string): Promise<string[]> {
  if (!(await exists(root))) {
    return [];
  }
  const entries = await readdir(root, { withFileTypes: true });
  return entries
    .filter((entry) => entry.isDirectory() && /^\d+$/.test(entry.name))
    .map((entry) => entry.name);
}

function scoreCandidate(gutenbergId: string, path: string): number {
  const base = path.split("/").at(-1)?.toLowerCase() ?? "";
  if (base === `pg${gutenbergId}-images.html`) return 120;
  if (base === `pg${gutenbergId}-h.htm` || base === `pg${gutenbergId}-h.html`) return 115;
  if (base.endsWith(".html") || base.endsWith(".htm")) return 95;
  if (base === `pg${gutenbergId}.txt`) return 90;
  if (base === `pg${gutenbergId}-0.txt`) return 85;
  if (base === `pg${gutenbergId}.txt.utf-8`) return 80;
  if (base === `${gutenbergId}.txt`) return 75;
  if (base.endsWith(".txt")) return 60;
  return -1;
}

function decodeEntities(input: string): string {
  return input
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, "\"")
    .replace(/&#39;/g, "'")
    .replace(/&rsquo;|&lsquo;/g, "'")
    .replace(/&rdquo;|&ldquo;/g, "\"")
    .replace(/&mdash;/g, "-")
    .replace(/&ndash;/g, "-")
    .replace(/&hellip;/g, "...")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">");
}

export function htmlToText(input: string): string {
  return decodeEntities(
    input
      .replace(/<script[\s\S]*?<\/script>/gi, " ")
      .replace(/<style[\s\S]*?<\/style>/gi, " ")
      .replace(/<br\s*\/?>/gi, "\n")
      .replace(/<\/p>/gi, "\n\n")
      .replace(/<\/div>/gi, "\n")
      .replace(/<[^>]+>/g, " ")
      .replace(/[ \t]+\n/g, "\n")
      .replace(/\n{3,}/g, "\n\n")
      .replace(/[ \t]{2,}/g, " ")
      .trim(),
  );
}

function parseRdfTitle(raw: string): string | null {
  const match = raw.match(/<dcterms:title>([\s\S]*?)<\/dcterms:title>/i);
  return match ? decodeEntities(match[1].trim()) : null;
}

function parseRdfSimpleText(raw: string, tagName: string): string | null {
  const match = raw.match(new RegExp(`<${tagName}>([\\s\\S]*?)<\\/${tagName}>`, "i"));
  return match ? decodeEntities(match[1].trim()) : null;
}

function uniqueValues(values: Array<string | null | undefined>) {
  const seen = new Set<string>();
  const normalized: string[] = [];
  for (const value of values) {
    const next = value?.trim();
    if (!next) {
      continue;
    }
    const key = next.toLowerCase();
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    normalized.push(next);
  }
  return normalized;
}

function cleanTitle(title: string | null): string | null {
  if (!title) {
    return null;
  }
  const normalized = decodeEntities(title)
    .replace(/^Project Gutenberg(?:'s)?\s+(?:eBook|EBook|Etext|eText)\s+of\s+/i, "")
    .replace(/^The Project Gutenberg eBook of\s+/i, "")
    .replace(/^The Project Gutenberg Copyrighted E-?text of\s+/i, "")
    .replace(/^The Project Gutenberg(?:'s)?\s+(?:eBook|EBook|eText|Etext)\s+of\s+/i, "")
    .replace(/\s+by\s+.+$/i, "")
    .replace(/\s*\|\s*Project Gutenberg.*$/i, "")
    .replace(/\s{2,}/g, " ")
    .trim()
    .replace(/^["']|["']$/g, "")
    .replace(/[.;,:-]+$/g, "")
    .trim();
  return normalized || null;
}

function cleanDescription(value: string | null): string | null {
  if (!value) {
    return null;
  }
  const normalized = decodeEntities(value)
    .replace(/\s+/g, " ")
    .replace(/^Summary:\s*/i, "")
    .trim();
  return normalized || null;
}

function parseHtmlTitle(raw: string): string | null {
  const match = raw.match(/<title>([\s\S]*?)<\/title>/i);
  return cleanTitle(match ? match[1].trim() : null);
}

function parseHtmlAuthor(raw: string): string | null {
  const titleMatch = raw.match(/<title>([\s\S]*?)<\/title>/i);
  if (titleMatch) {
    const normalized = decodeEntities(titleMatch[1].replace(/\s+/g, " ").trim());
    const byMatch = normalized.match(/\bby\s+(.+?)(?:\s*\|\s*Project Gutenberg.*)?$/i);
    if (byMatch) {
      return cleanTitle(byMatch[1]);
    }
  }

  const metaMatch = raw.match(/<meta[^>]+name=["']author["'][^>]+content=["']([^"']+)["']/i);
  return cleanTitle(metaMatch?.[1] ?? null);
}

function parseTextTitle(raw: string): string | null {
  const titleMatch = raw.match(/^\s*Title:\s*(.+)$/im);
  if (titleMatch) {
    return cleanTitle(titleMatch[1]);
  }

  const lines = raw
    .replace(/\r\n/g, "\n")
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
  const startIndex = lines.findIndex((line) => /^\*\*\*\s*START OF/i.test(line));
  const searchLines = startIndex >= 0 ? lines.slice(startIndex + 1, startIndex + 12) : lines.slice(0, 12);
  const candidate = searchLines.find((line) => {
    if (/^(author|release date|language|character set encoding|produced by|translated by):/i.test(line)) {
      return false;
    }
    if (/^project gutenberg/i.test(line)) {
      return false;
    }
    return /[a-z]/i.test(line);
  });
  return cleanTitle(candidate ?? null);
}

function parseTextAuthor(raw: string): string | null {
  const authorMatch = raw.match(/^\s*Author:\s*(.+)$/im);
  if (authorMatch) {
    return cleanTitle(authorMatch[1]);
  }

  const lines = raw
    .replace(/\r\n/g, "\n")
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
  const titleIndex = lines.findIndex((line) => /[a-z]/i.test(line) && !/^project gutenberg/i.test(line));
  const windowLines = titleIndex >= 0 ? lines.slice(titleIndex + 1, titleIndex + 6) : lines.slice(0, 6);
  const candidate = windowLines.find((line) => /^(by|di)\s+/i.test(line));
  if (!candidate) {
    return null;
  }
  return cleanTitle(candidate.replace(/^(by|di)\s+/i, ""));
}

function parseHtmlLanguage(raw: string): string | null {
  const attrMatch = raw.match(/<html[^>]+\blang=["']([^"']+)["']/i);
  return attrMatch?.[1]?.trim().toLowerCase() ?? null;
}

function parseLanguageList(raw: string): string[] {
  return uniqueValues(
    Array.from(raw.matchAll(/<dcterms:language[\s\S]*?<rdf:value>([\s\S]*?)<\/rdf:value>/gi)).map((match) =>
      decodeEntities(match[1]?.trim() ?? "").toLowerCase()
    ),
  );
}

function parseSubjectList(raw: string, tagName: "subject" | "bookshelf"): string[] {
  const namespace = tagName === "subject" ? "dcterms" : "pgterms";
  return uniqueValues(
    Array.from(raw.matchAll(new RegExp(`<${namespace}:${tagName}[\\s\\S]*?<rdf:value>([\\s\\S]*?)<\\/rdf:value>`, "gi"))).map(
      (match) => decodeEntities(match[1]?.trim() ?? ""),
    ),
  );
}

async function readOptionalFile(path: string | null): Promise<string | null> {
  if (!path || !(await exists(path))) {
    return null;
  }
  return await readFile(path, "utf8");
}

async function resolveCoverImagePath(root: string, gutenbergId: string): Promise<string | null> {
  const generatedRoot = generatedMirrorDirectory(root, gutenbergId);
  const candidates = await listFilesRecursive(generatedRoot, 1);
  for (const candidate of candidates.sort()) {
    if (/\/cover(?:\.[^/]+)?\.(?:jpg|jpeg|png|webp)$/i.test(candidate)) {
      return candidate;
    }
  }
  return null;
}

function parseAgentList(raw: string, tagNames: string[]): string[] {
  return uniqueValues(
    tagNames.flatMap((tagName) =>
      Array.from(raw.matchAll(new RegExp(`<${tagName}[\\s\\S]*?<pgterms:name>([\\s\\S]*?)<\\/pgterms:name>`, "gi"))).map(
        (match) => decodeEntities(match[1]?.trim() ?? ""),
      ),
    ),
  );
}

export async function listMirrorIds(root: string): Promise<string[]> {
  const [mainIds, generatedIds] = await Promise.all([
    listFilesRecursive(root, 8).then((paths) => paths.map(extractGutenbergIdFromPath).filter((value): value is string => Boolean(value))),
    listNumericDirectories(join(root, "cache", "epub")),
  ]);
  return uniqueValues([...mainIds, ...generatedIds]).sort((left, right) => Number(left) - Number(right));
}

export async function resolveMirrorSource(root: string, gutenbergId: string): Promise<MirrorSource> {
  const primaryRoot = mainMirrorDirectory(root, gutenbergId);
  const generatedRoot = generatedMirrorDirectory(root, gutenbergId);
  const fileCandidates = [
    ...(await listFilesRecursive(primaryRoot, 4)),
    ...(await listFilesRecursive(generatedRoot, 4)),
  ];
  const ranked = fileCandidates
    .map((path) => ({ path, score: scoreCandidate(gutenbergId, path) }))
    .filter((entry) => entry.score >= 0)
    .sort((left, right) => right.score - left.score);

  const sourcePath = ranked[0]?.path;
  if (!sourcePath) {
    throw new Error(`Could not find a Gutenberg source file for ${gutenbergId}.`);
  }

  const rawSource = await readFile(sourcePath, "utf8");
  const format = /\.html?(\.utf-8)?$/i.test(sourcePath) ? "html" : "text";
  const rawText = format === "html" ? htmlToText(rawSource) : rawSource.replace(/\r\n/g, "\n");
  const metadataPath = await (async () => {
    const candidates = [
      join(generatedRoot, "pg.rdf"),
      join(generatedRoot, `pg${gutenbergId}.rdf`),
      join(generatedRoot, `${gutenbergId}.rdf`),
    ];
    for (const candidate of candidates) {
      if (await exists(candidate)) {
        return candidate;
      }
    }
    return null;
  })();
  const rdf = await readOptionalFile(metadataPath);

  const title = cleanTitle(rdf ? parseRdfTitle(rdf) : (format === "html" ? parseHtmlTitle(rawSource) : parseTextTitle(rawSource)));
  const subtitle = cleanTitle(
    rdf ? (parseRdfSimpleText(rdf, "dcterms:alternative") ?? parseRdfSimpleText(rdf, "pgterms:friendlytitle")) : null,
  );
  const summary = cleanDescription(rdf ? parseRdfSimpleText(rdf, "dcterms:description") : null);
  const publisher = cleanTitle(rdf ? parseRdfSimpleText(rdf, "dcterms:publisher") : null);
  const authors = uniqueValues([
    rdf ? parseRdfSimpleText(rdf, "pgterms:name") : null,
    format === "html" ? parseHtmlAuthor(rawSource) : parseTextAuthor(rawSource),
  ]);
  const language = rdf ? parseLanguageList(rdf)[0] ?? null : parseHtmlLanguage(rawSource);
  const subjects = rdf ? parseSubjectList(rdf, "subject") : [];
  const bookshelves = rdf ? parseSubjectList(rdf, "bookshelf") : [];
  const translators = parseAgentList(rdf ?? "", ["pgterms:translator", "marcrel:trl"]);
  const illustrators = parseAgentList(rdf ?? "", ["pgterms:illustrator", "marcrel:ill"]);
  const editors = parseAgentList(rdf ?? "", ["pgterms:editor", "marcrel:edt"]);
  const releaseDate = rdf ? parseRdfSimpleText(rdf, "dcterms:issued") : null;
  const rightsStatus = rdf ? parseRdfSimpleText(rdf, "dcterms:rights") : null;
  const coverImagePath = await resolveCoverImagePath(root, gutenbergId);

  return {
    gutenbergId,
    title: title ?? `Project Gutenberg ${gutenbergId}`,
    subtitle,
    authors,
    subjects,
    bookshelves,
    language,
    releaseDate,
    rightsStatus,
    publisher,
    summary,
    translators,
    illustrators,
    editors,
    coverImagePath,
    sourcePath,
    metadataPath,
    format,
    rawSource,
    rawText,
    metadata: {
      bookshelves,
      translators,
      illustrators,
      editors,
      publisher,
      subtitle,
      metadataPath,
      coverImagePath,
    },
  };
}
