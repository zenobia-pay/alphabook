import { access, readFile, readdir } from "node:fs/promises";
import { join } from "node:path";

export interface MirrorSource {
  gutenbergId: string;
  title: string | null;
  sourcePath: string;
  metadataPath: string | null;
  format: "text" | "html";
  rawText: string;
  metadata: Record<string, unknown>;
}

function digitsPath(gutenbergId: string): string[] {
  const digits = gutenbergId.replace(/\D+/g, "");
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

async function listFilesRecursive(root: string, depth = 0): Promise<string[]> {
  if (!(await exists(root))) {
    return [];
  }
  const entries = await readdir(root, { withFileTypes: true });
  const files = await Promise.all(
    entries.map(async (entry) => {
      const fullPath = join(root, entry.name);
      if (entry.isDirectory()) {
        if (depth >= 2) {
          return [];
        }
        return listFilesRecursive(fullPath, depth + 1);
      }
      return [fullPath];
    }),
  );
  return files.flat();
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
  if (base === `pg${gutenbergId}.txt`) return 100;
  if (base === `pg${gutenbergId}-0.txt`) return 95;
  if (base === `pg${gutenbergId}.txt.utf-8`) return 90;
  if (base === `${gutenbergId}.txt`) return 85;
  if (base.endsWith(".txt")) return 70;
  if (base === `pg${gutenbergId}-images.html`) return 60;
  if (base === `pg${gutenbergId}-h.htm` || base === `pg${gutenbergId}-h.html`) return 55;
  if (base.endsWith(".html") || base.endsWith(".htm")) return 40;
  return -1;
}

function decodeEntities(input: string): string {
  return input
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, "\"")
    .replace(/&#39;/g, "'")
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

  return {
    gutenbergId,
    title: metadataRaw ? parseRdfTitle(metadataRaw) : null,
    sourcePath,
    metadataPath: metadataRaw ? metadataPath : null,
    format,
    rawText: format === "html" ? htmlToText(rawSource) : rawSource,
    metadata: {
      sourcePath,
      metadataPath: metadataRaw ? metadataPath : null,
      format,
      rdfTitle: metadataRaw ? parseRdfTitle(metadataRaw) : null,
    },
  };
}

export async function listMirrorIds(mirrorRoot: string): Promise<string[]> {
  const generatedRoot = join(mirrorRoot, "cache", "epub");
  const generatedIds = await listNumericDirectories(generatedRoot);
  if (generatedIds.length > 0) {
    return generatedIds.sort((left, right) => Number(left) - Number(right));
  }

  const mainFiles = await listFilesRecursive(mirrorRoot, 6);
  const discovered = new Set<string>();
  for (const path of mainFiles) {
    const match = path.match(/\/(\d+)\/[^/]+$/);
    if (match?.[1]) {
      discovered.add(match[1]);
    }
  }
  return [...discovered].sort((left, right) => Number(left) - Number(right));
}
