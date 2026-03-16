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
    .replace(/&mdash;/g, "—")
    .replace(/&ndash;/g, "–")
    .replace(/&hellip;/g, "…")
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

function parseTextLanguage(raw: string): string | null {
  const match = raw.match(/^\s*Language:\s*([A-Za-z-]+)\s*$/im);
  return match?.[1]?.trim().toLowerCase() ?? null;
}

function parseRdfList(raw: string, tagName: string) {
  return uniqueValues(
    [...raw.matchAll(new RegExp(`<${tagName}>([\\s\\S]*?)<\\/${tagName}>`, "gi"))].map((match) => decodeEntities(match[1]?.trim() ?? "")),
  );
}

function parseAgentNames(raw: string, tagName: string) {
  return uniqueValues(
    [...raw.matchAll(new RegExp(`<${tagName}>[\\s\\S]*?<pgterms:name>([^<]+)<\\/pgterms:name>[\\s\\S]*?<\\/${tagName}>`, "gi"))].map((match) => cleanTitle(match[1]?.trim() ?? "") ?? ""),
  );
}

function parseRdfMetadata(raw: string | null) {
  if (!raw) {
    return {
      title: null,
      subtitle: null,
      authors: [] as string[],
      subjects: [] as string[],
      bookshelves: [] as string[],
      language: null as string | null,
      releaseDate: null as string | null,
      rightsStatus: null as string | null,
      publisher: null as string | null,
      summary: null as string | null,
      translators: [] as string[],
      illustrators: [] as string[],
      editors: [] as string[],
    };
  }

  const title = cleanTitle(parseRdfTitle(raw));
  const authors = parseAgentNames(raw, "dcterms:creator");
  const subjects = uniqueValues(
    [...raw.matchAll(/<dcterms:subject>[\s\S]*?<rdf:value>([^<]+)<\/rdf:value>[\s\S]*?<\/dcterms:subject>/gi)].map((match) => decodeEntities(match[1]?.trim() ?? "")),
  );
  const bookshelves = uniqueValues(
    [...raw.matchAll(/<pgterms:bookshelf>[\s\S]*?<rdf:value>([^<]+)<\/rdf:value>[\s\S]*?<\/pgterms:bookshelf>/gi)].map((match) => decodeEntities(match[1]?.trim() ?? "")),
  );
  const language = raw.match(/<dcterms:language>[\s\S]*?<rdf:value>([^<]+)<\/rdf:value>/i)?.[1]?.trim().toLowerCase() ?? null;
  const releaseDate = raw.match(/<dcterms:issued>([^<]+)<\/dcterms:issued>/i)?.[1]?.trim() ?? null;
  const rightsStatus = raw.match(/<dcterms:rights>([^<]+)<\/dcterms:rights>/i)?.[1]?.trim() ?? null;
  const publisher = cleanTitle(parseRdfSimpleText(raw, "dcterms:publisher"));
  const summary = cleanDescription(parseRdfSimpleText(raw, "dcterms:description"));
  const subtitle = cleanTitle(parseRdfSimpleText(raw, "pgterms:friendlytitle"));
  const translators = parseAgentNames(raw, "marcrel:trl");
  const illustrators = parseAgentNames(raw, "marcrel:ill");
  const editors = parseAgentNames(raw, "marcrel:edt");

  return {
    title,
    subtitle,
    authors: uniqueValues(authors),
    subjects: uniqueValues(subjects),
    bookshelves,
    language,
    releaseDate,
    rightsStatus,
    publisher,
    summary,
    translators,
    illustrators,
    editors,
  };
}

async function findCoverImagePath(generatedDir: string, mainDir: string, gutenbergId: string): Promise<string | null> {
  const candidates = [...(await listFilesRecursive(generatedDir)), ...(await listFilesRecursive(mainDir))]
    .filter((path) => /\.(png|jpe?g|webp)$/i.test(path))
    .sort((left, right) => {
      const leftBase = basename(left).toLowerCase();
      const rightBase = basename(right).toLowerCase();
      const score = (base: string) => {
        if (base.includes("cover")) return 100;
        if (base === `pg${gutenbergId}.jpg` || base === `pg${gutenbergId}.jpeg` || base === `pg${gutenbergId}.png`) return 90;
        return 10;
      };
      return score(rightBase) - score(leftBase);
    });
  return candidates[0] ?? null;
}

export async function resolveMirrorSource(mirrorRoot: string, gutenbergId: string): Promise<MirrorSource> {
  const generatedDir = generatedMirrorDirectory(mirrorRoot, gutenbergId);
  const mainDir = mainMirrorDirectory(mirrorRoot, gutenbergId);
  const metadataPath = join(generatedDir, `pg${gutenbergId}.rdf`);

  const candidates = [...(await listFilesRecursive(generatedDir)), ...(await listFilesRecursive(mainDir))]
    .filter((path) => {
      const lower = path.toLowerCase();
      return lower.endsWith(".txt") || lower.endsWith(".txt.utf-8") || lower.endsWith(".html") || lower.endsWith(".htm");
    })
    .sort((left, right) => scoreCandidate(gutenbergId, right) - scoreCandidate(gutenbergId, left));

  const sourcePath = candidates[0];
  if (!sourcePath) {
    throw new Error(`Could not find mirrored source files for Gutenberg ID ${gutenbergId} under ${mirrorRoot}.`);
  }

  const rawSource = await readFile(sourcePath, "utf8");
  const metadataRaw = (await exists(metadataPath)) ? await readFile(metadataPath, "utf8") : null;
  const format = /\.html?$/i.test(sourcePath) ? "html" : "text";
  const derivedTitle = format === "html" ? parseHtmlTitle(rawSource) : parseTextTitle(rawSource);
  const derivedAuthor = format === "html" ? parseHtmlAuthor(rawSource) : parseTextAuthor(rawSource);
  const derivedLanguage = format === "html" ? parseHtmlLanguage(rawSource) : parseTextLanguage(rawSource);
  const rdfMetadata = parseRdfMetadata(metadataRaw);
  const coverImagePath = await findCoverImagePath(generatedDir, mainDir, gutenbergId);

  return {
    gutenbergId,
    title: rdfMetadata.title ?? derivedTitle,
    subtitle: rdfMetadata.subtitle,
    authors: rdfMetadata.authors.length > 0 ? rdfMetadata.authors : uniqueValues([derivedAuthor]),
    subjects: rdfMetadata.subjects,
    bookshelves: rdfMetadata.bookshelves,
    language: rdfMetadata.language ?? derivedLanguage,
    releaseDate: rdfMetadata.releaseDate,
    rightsStatus: rdfMetadata.rightsStatus,
    publisher: rdfMetadata.publisher,
    summary: rdfMetadata.summary,
    translators: rdfMetadata.translators,
    illustrators: rdfMetadata.illustrators,
    editors: rdfMetadata.editors,
    coverImagePath,
    sourcePath,
    metadataPath: metadataRaw ? metadataPath : null,
    format,
    rawSource,
    rawText: format === "html" ? htmlToText(rawSource) : rawSource,
    metadata: {
      sourcePath,
      metadataPath: metadataRaw ? metadataPath : null,
      format,
      rdfTitle: rdfMetadata.title,
      subtitle: rdfMetadata.subtitle,
      derivedTitle,
      authors: rdfMetadata.authors.length > 0 ? rdfMetadata.authors : uniqueValues([derivedAuthor]),
      subjects: rdfMetadata.subjects,
      bookshelves: rdfMetadata.bookshelves,
      language: rdfMetadata.language ?? derivedLanguage,
      releaseDate: rdfMetadata.releaseDate,
      rightsStatus: rdfMetadata.rightsStatus,
      publisher: rdfMetadata.publisher,
      summary: rdfMetadata.summary,
      translators: rdfMetadata.translators,
      illustrators: rdfMetadata.illustrators,
      editors: rdfMetadata.editors,
      coverImagePath,
    },
  };
}

export async function listMirrorIds(mirrorRoot: string): Promise<string[]> {
  const generatedRoot = join(mirrorRoot, "cache", "epub");
  const generatedIds = await listNumericDirectories(generatedRoot);
  if (generatedIds.length > 0) {
    return generatedIds.sort((left, right) => Number(left) - Number(right));
  }

  const mainFiles = await listFilesRecursive(mirrorRoot, 8);
  const discovered = new Set<string>();
  for (const path of mainFiles) {
    const match = extractGutenbergIdFromPath(path);
    if (match) {
      discovered.add(match);
    }
  }
  return [...discovered].sort((left, right) => Number(left) - Number(right));
}
