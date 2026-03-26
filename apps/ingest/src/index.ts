import process from "node:process";
import crypto from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { Agent as HttpsAgent } from "node:https";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { DeleteObjectsCommand, GetObjectCommand, S3Client, PutObjectCommand } from "@aws-sdk/client-s3";
import { NodeHttpHandler } from "@smithy/node-http-handler";
import { parseHTML } from "linkedom";
import type { DbClient } from "@alphabook/db";
import { createWranglerD1Db, loadLocalDevVars } from "@alphabook/db";
import type { CorpusAdapter } from "@alphabook/corpus-core";
import {
  buildSimpleRenderedArtifactBundle,
  prepareCorpusIngest,
  type CorpusIngestSourceInput,
  type RenderedArtifactBundle,
} from "./corpus-ingest";
import {
  fixtureCorpusAdapter,
  fixtureDocuments,
  fixtureDocumentSources,
} from "@alphabook/source-fixture";
import { gutenbergCorpusAdapter } from "@alphabook/source-gutenberg/adapter";
import { listMirrorIds, resolveMirrorSource } from "@alphabook/source-gutenberg/mirror";
import {
  CourtListenerCaseLawClient,
  buildSupremeCourtCaseSource,
  supremeCourtCases,
  supremeCourtCaseSources,
  supremeCourtCorpusAdapter,
} from "@alphabook/source-supreme-court";

interface IngestContext {
  db: DbClient;
  r2: S3Client;
  r2Bucket: string;
  vectorIndexName: string | null;
  vectorWranglerConfig: string;
}

interface MirrorBackfillOptions {
  startAfterId?: string | null;
  limit: number;
  checkpointPath?: string | null;
  concurrency?: number;
}

interface MirrorBackfillCheckpoint {
  lastProcessedId: string | null;
  processed: number;
  updatedAt: string;
}

interface SupremeCourtBackfillOptions {
  startAfterId?: number | null;
  limit: number;
}

interface ExistingWorkStatus {
  workId: string;
  complete: boolean;
}

interface ExistingBookHtmlWork {
  workId: string;
  gutenbergId: string;
  title: string;
  summary: string | null;
  language: string | null;
  releaseDate: string | null;
  metadata: Record<string, unknown>;
}

interface BookHtmlPersistResult {
  workId: string;
  gutenbergId: string;
  bookHtmlKey?: string;
  skipped?: boolean;
  error?: string;
}

type BookBlockKind = "heading" | "paragraph" | "blockquote" | "preformatted" | "list";

type BookBlock = {
  kind: BookBlockKind;
  html: string;
  text: string;
  wordCount: number;
  passageIds: string[];
  headingLevel?: number;
  sectionId?: string | null;
  sectionTitle?: string | null;
};

type BookPage = {
  pageNumber: number;
  href: string;
  wordCount: number;
  sectionTitle: string | null;
  firstPassageId: string | null;
  lastPassageId: string | null;
  blocks: BookBlock[];
};

type BookSection = {
  id: string;
  title: string;
  level: number;
  pageNumber: number;
  href: string;
  passageId: string;
};

type BookArtifactBundle = {
  landingHtml: string;
  manifestJson: string;
  pages: Array<{
    pageNumber: number;
    html: string;
  }>;
};

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

const execFileAsync = promisify(execFile);

function normalizeEmbedding(values: number[]): number[] {
  const magnitude = Math.sqrt(values.reduce((sum, value) => sum + value * value, 0));
  if (magnitude === 0) {
    return values;
  }
  return values.map((value) => value / magnitude);
}

async function embedChunks(chunks: string[]): Promise<number[][] | null> {
  const provider = process.env.EMBEDDING_PROVIDER ?? "openai";
  if (chunks.length === 0) {
    return null;
  }
  if (provider === "google") {
    return embedChunksWithGoogle(chunks);
  }
  return embedChunksWithOpenAI(chunks);
}

async function embedChunksWithOpenAI(chunks: string[]): Promise<number[][] | null> {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey || chunks.length === 0) {
    return null;
  }
  const model = process.env.OPENAI_EMBEDDING_MODEL ?? "text-embedding-3-small";
  const embeddings: number[][] = [];

  for (let index = 0; index < chunks.length; index += 32) {
    const batch = chunks.slice(index, index + 32);
    let response: Response | null = null;
    let lastError: string | null = null;

    for (let attempt = 0; attempt < 5; attempt += 1) {
      try {
        response = await fetch("https://api.openai.com/v1/embeddings", {
          method: "POST",
          headers: {
            "content-type": "application/json",
            authorization: `Bearer ${apiKey}`,
          },
          body: JSON.stringify({
            model,
            input: batch,
            ...(model.startsWith("text-embedding-3-") ? { dimensions: 1536 } : {}),
          }),
        });
        if (response.ok) {
          break;
        }
        const body = await response.text();
        lastError = `Embedding request failed: ${response.status} ${body}`;
        if (response.status !== 429 && response.status < 500) {
          throw new Error(lastError);
        }
      } catch (error) {
        lastError = error instanceof Error ? error.message : String(error);
      }

      if (attempt < 4) {
        await sleep(1000 * 2 ** attempt);
      }
    }

    if (!response?.ok) {
      throw new Error(lastError ?? "Embedding request failed.");
    }

    const payload = (await response.json()) as {
      data?: Array<{
        embedding?: number[];
      }>;
    };
    const nextVectors = (payload.data ?? []).map((item) => item.embedding ?? []);
    embeddings.push(...nextVectors);
  }

  if (embeddings.length !== chunks.length || embeddings.some((vector) => vector.length === 0)) {
    throw new Error("Embedding response length did not match the number of chunks.");
  }

  return embeddings;
}

async function embedChunksWithGoogle(chunks: string[]): Promise<number[][] | null> {
  const apiKey = process.env.GOOGLE_AI_API_KEY;
  if (!apiKey || chunks.length === 0) {
    return null;
  }

  const model = process.env.GOOGLE_EMBEDDING_MODEL ?? "gemini-embedding-2-preview";
  const outputDimensionality = Number(process.env.GOOGLE_EMBEDDING_DIMENSIONS ?? "1536");
  const embeddings: number[][] = [];

  for (const chunk of chunks) {
    let response: Response | null = null;
    let lastError: string | null = null;

    for (let attempt = 0; attempt < 5; attempt += 1) {
      try {
        response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:embedContent`, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-goog-api-key": apiKey,
          },
          body: JSON.stringify({
            model: `models/${model}`,
            content: {
              parts: [{ text: chunk }],
            },
            output_dimensionality: outputDimensionality,
          }),
        });
        if (response.ok) {
          break;
        }
        const body = await response.text();
        lastError = `Google embedding request failed: ${response.status} ${body}`;
        if (response.status !== 429 && response.status < 500) {
          throw new Error(lastError);
        }
      } catch (error) {
        lastError = error instanceof Error ? error.message : String(error);
      }

      if (attempt < 4) {
        await sleep(1000 * 2 ** attempt);
      }
    }

    if (!response?.ok) {
      throw new Error(lastError ?? "Google embedding request failed.");
    }

    const payload = (await response.json()) as {
      embedding?: {
        values?: number[];
      };
    };
    const vector = payload.embedding?.values;
    if (!vector?.length) {
      throw new Error("Google embedding response was empty.");
    }
    embeddings.push(normalizeEmbedding(vector));
  }

  if (embeddings.length !== chunks.length || embeddings.some((vector) => vector.length === 0)) {
    throw new Error("Google embedding response length did not match the number of chunks.");
  }

  return embeddings;
}

async function upsertChunkVectors(
  context: IngestContext,
  vectors: Array<{
    id: string;
    values: number[];
    metadata: Record<string, unknown>;
  }>,
) {
  if (!context.vectorIndexName || vectors.length === 0) {
    return;
  }
  const tempDir = await mkdtemp(join(tmpdir(), "alphabook-vectorize-"));
  const payloadPath = join(tempDir, "vectors.ndjson");
  try {
    await writeFile(
      payloadPath,
      `${vectors.map((vector) => JSON.stringify(vector)).join("\n")}\n`,
      "utf8",
    );
    await execFileAsync("npx", [
      "wrangler",
      "vectorize",
      "upsert",
      context.vectorIndexName,
      "--file",
      payloadPath,
      "--config",
      context.vectorWranglerConfig,
    ], {
      cwd: process.cwd(),
      env: process.env,
      maxBuffer: 20 * 1024 * 1024,
    });
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
}

function uniqueStrings(values: Array<string | null | undefined>) {
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

function escapeHtml(value: string) {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll("\"", "&quot;")
    .replaceAll("'", "&#39;");
}

function stripTags(value: string) {
  return value.replace(/<[^>]+>/g, " ");
}

function normalizeWhitespace(value: string) {
  return value.replace(/\s+/g, " ").trim();
}

function normalizeReaderText(input: string, preserveLineBreaks = false) {
  const normalized = input
    .replace(/\u00a0/g, " ")
    .replace(/\r\n/g, "\n")
    .replace(/[ \t]+\n/g, "\n")
    .trim();

  if (preserveLineBreaks) {
    return normalized.replace(/\n{3,}/g, "\n\n").trim();
  }

  return normalized.replace(/\s+/g, " ").trim();
}

function hashText(value: string) {
  let hash = 0;
  for (const character of value) {
    hash = (hash * 33 + character.charCodeAt(0)) >>> 0;
  }
  return hash.toString(36);
}

function createReaderPassageId(index: number, text: string) {
  return `passage-${index + 1}-${hashText(text).slice(0, 6)}`;
}

function createExcerpt(value: string, maxLength = 240) {
  const normalized = normalizeWhitespace(stripTags(value));
  if (normalized.length <= maxLength) {
    return normalized;
  }
  return `${normalized.slice(0, maxLength - 1).trimEnd()}…`;
}

function sanitizeSourceHtml(content: string) {
  const bodyMatch = content.match(/<body[^>]*>([\s\S]*?)<\/body>/i);
  const extracted = bodyMatch?.[1] ?? content;
  return extracted
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, "")
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, "")
    .replace(/<(?:link|meta|base|iframe|object|embed|form|input|button)[^>]*>/gi, "")
    .replace(/\son[a-z]+\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)/gi, "")
    .replace(/\s(?:href|src)\s*=\s*(['"])\s*javascript:[\s\S]*?\1/gi, "");
}

const PAGE_TARGET_WORDS = 400;
const PAGE_MIN_WORDS = 360;
const PAGE_MAX_WORDS = 440;
const PAGE_TINY_MERGE_THRESHOLD = 180;

type PaginatedBookBlockKind = "heading" | "paragraph" | "blockquote" | "preformatted" | "list";

type PaginatedBookBlock = {
  kind: PaginatedBookBlockKind;
  html: string;
  text: string;
  wordCount: number;
  passageIds: string[];
  sectionTitle?: string | null;
  sectionId?: string | null;
};

type PaginatedBookPage = {
  pageNumber: number;
  href: string;
  wordCount: number;
  sectionTitle: string | null;
  firstPassageId: string | null;
  lastPassageId: string | null;
  blocks: PaginatedBookBlock[];
};

type PaginatedBookSection = {
  id: string;
  title: string;
  href: string;
  pageNumber: number;
  passageId: string;
};

function countWords(value: string) {
  return normalizeWhitespace(value).split(/\s+/).filter(Boolean).length;
}

function slugify(value: string) {
  return value
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^\w\s-]/g, "")
    .trim()
    .replace(/[-\s]+/g, "-")
    .replace(/^-+|-+$/g, "") || "section";
}

function createBookPageHref(pageNumber: number) {
  return `./pages/page-${String(pageNumber).padStart(4, "0")}.html`;
}

function createBookSectionId(title: string, index: number) {
  return `section-${slugify(title)}-${index + 1}`;
}

const STATIC_BOOK_CONTENT_VERSION = "20260320b";

function withBookVersion(href: string, fragment?: string | null) {
  const separator = href.includes("?") ? "&" : "?";
  return `${href}${separator}v=${STATIC_BOOK_CONTENT_VERSION}${fragment ? `#${fragment}` : ""}`;
}

function renderBookStaticStyles() {
  return `
      :root {
        color-scheme: light;
        --bg: #f6f3ee;
        --ink: #171717;
        --muted: rgba(23, 23, 23, 0.62);
        --line: rgba(23, 23, 23, 0.08);
        --accent: rgba(37, 99, 235, 0.16);
        --accent-strong: rgba(37, 99, 235, 0.24);
      }
      * { box-sizing: border-box; }
      html { scroll-behavior: smooth; }
      body {
        margin: 0;
        font-family: "Newsreader", Georgia, serif;
        color: var(--ink);
        background: transparent;
        text-rendering: optimizeLegibility;
        -webkit-font-smoothing: antialiased;
        -moz-osx-font-smoothing: grayscale;
      }
      a {
        color: inherit;
        text-decoration-thickness: 0.06em;
        text-underline-offset: 0.14em;
      }
      .page-shell {
        width: min(84ch, calc(100vw - 12px));
        margin: 0 auto;
        padding: 4px 0 14px;
      }
      .hero {
        display: grid;
        gap: 6px;
        margin-bottom: 1.2rem;
      }
      .eyebrow, .byline, .summary, .page-kicker, .page-meta, .page-position {
        margin: 0;
        color: var(--muted);
        font-size: 0.96rem;
        line-height: 1.5;
      }
      h1 {
        margin: 0;
        font-size: clamp(2rem, 4vw, 3.25rem);
        line-height: 0.96;
        letter-spacing: -0.04em;
        font-weight: 600;
      }
      .meta-list {
        margin: 0;
        color: var(--muted);
      }
      .meta-list span + span::before {
        content: " · ";
      }
      .toc-list {
        list-style: none;
        padding: 0;
        margin: 0;
        display: grid;
        gap: 0.55rem;
      }
      .toc-link, .page-link, .nav-link {
        text-decoration: underline;
      }
      .reader-body {
        font-size: 1.14rem;
        line-height: 1.72;
      }
      .reader-body h1, .reader-body h2, .reader-body h3, .reader-body h4, .reader-body h5, .reader-body h6 {
        font-size: 1.18em;
        line-height: 1.18;
        margin: 1.7em 0 0.45em;
        letter-spacing: -0.02em;
      }
      .reader-body p, .reader-body li, .reader-body blockquote, .reader-body pre {
        margin: 0 0 1em;
      }
      .reader-body blockquote {
        margin-left: 0;
        padding-left: 0;
        color: var(--muted);
        font-style: italic;
      }
      .reader-body pre {
        white-space: pre-wrap;
        font: inherit;
        line-height: 1.65;
      }
      .reader-body [data-passage-id],
      .reader-body [data-anchor-id] {
        scroll-margin-top: 24px;
      }
      .reader-body [data-passage-id].is-selected,
      .reader-body .reader-line.is-selected,
      .reader-body [data-passage-id]:target {
        text-decoration-line: underline;
        text-decoration-color: var(--accent-strong);
        text-decoration-thickness: 0.14em;
        text-underline-offset: 0.14em;
        outline: none;
      }
      .reader-body [data-passage-id].is-block-selected {
        text-decoration-line: underline;
        text-decoration-color: var(--accent);
        text-decoration-thickness: 0.12em;
        text-underline-offset: 0.14em;
      }
      .reader-body .reader-heading {
        cursor: pointer;
      }
      .reader-body .reader-line {
        display: inline;
        cursor: pointer;
      }
      .reader-body .reader-line + br {
        content: "";
      }
      .reader-body .reader-line:empty::before {
        content: " ";
      }
      ::highlight(alphabook-selection) {
        background: var(--accent-strong);
      }
      .page-nav {
        display: flex;
        justify-content: space-between;
        align-items: baseline;
        gap: 1rem;
        margin: 0 0 0.8rem;
      }
      .page-nav-bottom {
        margin-top: 1rem;
      }
      .page-nav-links {
        display: flex;
        gap: 1rem;
        flex-wrap: wrap;
      }
      .toc-title {
        margin: 1.3rem 0 0.65rem;
        font-size: 1rem;
        font-weight: 600;
        letter-spacing: 0.01em;
      }
      .empty-state {
        color: var(--muted);
      }
      @media (max-width: 780px) {
        .page-shell {
          width: min(100vw - 8px, 100%);
          padding: 2px 0 12px;
        }
        .reader-body {
          font-size: 1.06rem;
          line-height: 1.66;
        }
        .page-nav {
          flex-direction: column;
          align-items: flex-start;
        }
      }
  `;
}

function renderBookSelectionScript() {
  return `
      (() => {
        const root = document.querySelector(".reader-body");
        if (!root) {
          return;
        }

        const sentenceSegmenter = typeof Intl !== "undefined" && typeof Intl.Segmenter === "function"
          ? new Intl.Segmenter(document.documentElement.lang || undefined, { granularity: "sentence" })
          : null;
        let activeTarget = null;

        function emitReaderLocation() {
          try {
            window.parent?.postMessage({
              type: "alphabook-reader-location",
              path: window.location.pathname + window.location.hash,
            }, "*");
          } catch {}
        }

        function clearHighlight() {
          if (activeTarget) {
            activeTarget.classList.remove("is-selected");
            activeTarget.classList.remove("is-block-selected");
            activeTarget = null;
          }
          if (window.CSS && CSS.highlights) {
            CSS.highlights.delete("alphabook-selection");
          }
        }

        function sentenceRanges(text) {
          const ranges = [];
          if (!text || !text.trim()) {
            return ranges;
          }
          if (sentenceSegmenter) {
            let index = 0;
            for (const part of sentenceSegmenter.segment(text)) {
              const value = typeof part.segment === "string" ? part.segment : "";
              const start = typeof part.index === "number" ? part.index : index;
              const end = start + value.length;
              if (value.trim()) {
                ranges.push({ start, end });
              }
              index = end;
            }
          }
          if (ranges.length > 0) {
            return ranges;
          }
          const fallback = text.matchAll(/[^.!?\\n]+(?:[.!?]+|$)/g);
          for (const match of fallback) {
            const value = match[0] || "";
            const start = match.index || 0;
            const end = start + value.length;
            if (value.trim()) {
              ranges.push({ start, end });
            }
          }
          return ranges.length > 0 ? ranges : [{ start: 0, end: text.length }];
        }

        function findTextOffset(container, targetNode, targetOffset) {
          const walker = document.createTreeWalker(container, NodeFilter.SHOW_TEXT);
          let total = 0;
          while (walker.nextNode()) {
            const node = walker.currentNode;
            const length = node.textContent ? node.textContent.length : 0;
            if (node === targetNode) {
              return total + Math.min(targetOffset, length);
            }
            total += length;
          }
          return total;
        }

        function rangeForOffsets(container, start, end) {
          const walker = document.createTreeWalker(container, NodeFilter.SHOW_TEXT);
          let total = 0;
          let startNode = null;
          let startOffset = 0;
          let endNode = null;
          let endOffset = 0;
          while (walker.nextNode()) {
            const node = walker.currentNode;
            const length = node.textContent ? node.textContent.length : 0;
            if (!startNode && start <= total + length) {
              startNode = node;
              startOffset = Math.max(0, start - total);
            }
            if (!endNode && end <= total + length) {
              endNode = node;
              endOffset = Math.max(0, end - total);
              break;
            }
            total += length;
          }
          if (!startNode || !endNode) {
            return null;
          }
          const range = document.createRange();
          range.setStart(startNode, startOffset);
          range.setEnd(endNode, Math.max(startOffset, endOffset));
          return range;
        }

        function highlightSentence(block, sentenceIndex, scrollIntoView) {
          const text = block.textContent || "";
          const ranges = sentenceRanges(text);
          const sentence = ranges[sentenceIndex];
          if (!sentence) {
            highlightBlock(block, scrollIntoView);
            return;
          }
          clearHighlight();
          activeTarget = block;
          block.classList.add("is-block-selected");
          const range = rangeForOffsets(block, sentence.start, sentence.end);
          if (range && window.CSS && CSS.highlights && typeof window.Highlight === "function") {
            CSS.highlights.set("alphabook-selection", new Highlight(range));
          }
          if (scrollIntoView) {
            block.scrollIntoView({ block: "center", inline: "nearest" });
          }
        }

        function highlightBlock(block, scrollIntoView) {
          clearHighlight();
          activeTarget = block;
          block.classList.add("is-selected");
          if (scrollIntoView) {
            block.scrollIntoView({ block: "center", inline: "nearest" });
          }
        }

        function highlightLine(line, scrollIntoView) {
          clearHighlight();
          activeTarget = line;
          line.classList.add("is-selected");
          if (scrollIntoView) {
            line.scrollIntoView({ block: "center", inline: "nearest" });
          }
        }

        function applyHash(scrollIntoView) {
          const hash = window.location.hash.replace(/^#/, "");
          if (!hash) {
            clearHighlight();
            return;
          }
          if (hash.startsWith("sentence-")) {
            const parts = hash.split("-");
            const sentenceIndex = Number(parts.pop()) - 1;
            const passageId = parts.slice(1).join("-");
            const block = document.getElementById(passageId);
            if (block) {
              highlightSentence(block, Math.max(0, sentenceIndex), scrollIntoView);
              return;
            }
          }
          const line = root.querySelector('[data-anchor-id="' + CSS.escape(hash) + '"]');
          if (line) {
            highlightLine(line, scrollIntoView);
            return;
          }
          const target = document.getElementById(hash);
          if (target) {
            highlightBlock(target, scrollIntoView);
            return;
          }
          clearHighlight();
        }

        function sentenceIndexFromClick(block, event) {
          let caretNode = null;
          let caretOffset = 0;
          if (document.caretPositionFromPoint) {
            const position = document.caretPositionFromPoint(event.clientX, event.clientY);
            caretNode = position ? position.offsetNode : null;
            caretOffset = position ? position.offset : 0;
          } else if (document.caretRangeFromPoint) {
            const range = document.caretRangeFromPoint(event.clientX, event.clientY);
            caretNode = range ? range.startContainer : null;
            caretOffset = range ? range.startOffset : 0;
          }
          if (!caretNode || !block.contains(caretNode)) {
            return 0;
          }
          const offset = findTextOffset(block, caretNode, caretOffset);
          const ranges = sentenceRanges(block.textContent || "");
          const index = ranges.findIndex((range) => offset >= range.start && offset <= range.end);
          return index >= 0 ? index : 0;
        }

        root.addEventListener("click", (event) => {
          if (window.getSelection && String(window.getSelection()).trim()) {
            return;
          }
          const target = event.target;
          if (!(target instanceof Element)) {
            return;
          }
          if (target.closest("a[href]")) {
            return;
          }
          const line = target.closest("[data-anchor-id]");
          if (line instanceof HTMLElement) {
            event.preventDefault();
            const anchorId = line.getAttribute("data-anchor-id");
            if (!anchorId) {
              return;
            }
            history.replaceState(null, "", "#" + anchorId);
            applyHash(false);
            emitReaderLocation();
            return;
          }
          const block = target.closest("[data-passage-id]");
          if (!(block instanceof HTMLElement)) {
            return;
          }
          event.preventDefault();
          const passageId = block.getAttribute("data-passage-id");
          if (!passageId) {
            return;
          }
          if (/^H[1-6]$/.test(block.tagName)) {
            history.replaceState(null, "", "#" + passageId);
            applyHash(false);
            emitReaderLocation();
            return;
          }
          if (block.tagName === "PRE") {
            history.replaceState(null, "", "#" + passageId);
            applyHash(false);
            emitReaderLocation();
            return;
          }
          const sentenceIndex = sentenceIndexFromClick(block, event);
          history.replaceState(null, "", "#sentence-" + passageId + "-" + String(sentenceIndex + 1));
          applyHash(false);
          emitReaderLocation();
        });

        window.addEventListener("hashchange", () => {
          applyHash(true);
          emitReaderLocation();
        });
        applyHash(true);
        emitReaderLocation();
      })();
  `;
}

function renderPreformattedBlockHtml(passageId: string, content: string) {
  const lines = normalizeReaderText(content, true).split("\n");
  return `<pre id="${passageId}" data-passage-id="${passageId}">${lines.map((line, index) => {
    const lineId = `line-${passageId}-${index + 1}`;
    return `<span class="reader-line" data-anchor-id="${lineId}">${line.length > 0 ? escapeHtml(line) : ""}</span>`;
  }).join("<br />")}</pre>`;
}

function looksLikePlaintextHeading(value: string) {
  const cleaned = value.trim();
  const words = countWords(cleaned);
  return words > 0 && words <= 12 && cleaned.length <= 96 && !/[.!?;:]$/.test(cleaned);
}

function looksLikeVerseBlock(value: string) {
  const lines = value.split("\n").map((line) => line.trim()).filter(Boolean);
  if (lines.length < 3) {
    return false;
  }
  const averageLength = lines.reduce((total, line) => total + line.length, 0) / lines.length;
  return averageLength <= 42;
}

function buildPaginatedTextBlocks(content: string) {
  const paragraphs = gutenbergCorpusAdapter.text.stripSourceBoilerplate(content)
    .replace(/\r\n/g, "\n")
    .split(/\n{2,}/)
    .map((paragraph) => normalizeReaderText(paragraph, true))
    .filter(Boolean);
  const blocks: PaginatedBookBlock[] = [];
  let passageIndex = 0;
  let sectionIndex = 0;

  for (const paragraph of paragraphs) {
    const passageId = createReaderPassageId(passageIndex, paragraph);
    passageIndex += 1;
    if (looksLikePlaintextHeading(paragraph)) {
      blocks.push({
        kind: "heading",
        html: `<h2 id="${passageId}" data-passage-id="${passageId}" class="reader-heading">${escapeHtml(paragraph)}</h2>`,
        text: paragraph,
        wordCount: countWords(paragraph),
        passageIds: [passageId],
        sectionTitle: paragraph,
        sectionId: createBookSectionId(paragraph, sectionIndex++),
      });
      continue;
    }
    if (looksLikeVerseBlock(paragraph)) {
      blocks.push({
        kind: "preformatted",
        html: renderPreformattedBlockHtml(passageId, paragraph),
        text: paragraph,
        wordCount: countWords(paragraph),
        passageIds: [passageId],
      });
      continue;
    }
    blocks.push({
      kind: "paragraph",
      html: `<p id="${passageId}" data-passage-id="${passageId}">${escapeHtml(paragraph).replace(/\n/g, "<br />")}</p>`,
      text: paragraph,
      wordCount: countWords(paragraph),
      passageIds: [passageId],
    });
  }

  return blocks;
}

function buildPaginatedHtmlBlocks(content: string) {
  const sanitized = sanitizeSourceHtml(content);
  const { document } = parseHTML(`<!doctype html><html><body>${sanitized}</body></html>`);
  for (const node of Array.from(document.querySelectorAll("script, style, link, meta, base, noscript, iframe"))) {
    node.remove();
  }

  const selector = "h1, h2, h3, h4, h5, h6, p, blockquote, pre, ul, ol";
  const elements = Array.from(document.body.querySelectorAll(selector))
    .filter((element) => !element.parentElement?.closest(selector));
  const blocks: PaginatedBookBlock[] = [];
  let passageIndex = 0;
  let sectionIndex = 0;

  for (const element of elements) {
    const tagName = element.tagName.toLowerCase();
    const text = normalizeReaderText(
      tagName === "pre" ? element.textContent ?? "" : (element.textContent ?? "").replace(/\s+/g, " "),
      tagName === "pre",
    );
    if (!text) {
      continue;
    }

    if (/^h[1-6]$/.test(tagName)) {
      const passageId = createReaderPassageId(passageIndex, text);
      passageIndex += 1;
      element.setAttribute("id", passageId);
      element.setAttribute("data-passage-id", passageId);
      element.classList.add("reader-heading");
      blocks.push({
        kind: "heading",
        html: element.outerHTML,
        text,
        wordCount: countWords(text),
        passageIds: [passageId],
        sectionTitle: text,
        sectionId: createBookSectionId(text, sectionIndex++),
      });
      continue;
    }

    if (tagName === "ul" || tagName === "ol") {
      const items = Array.from(element.querySelectorAll(":scope > li"));
      const passageIds: string[] = [];
      for (const item of items) {
        const itemText = normalizeReaderText((item.textContent ?? "").replace(/\s+/g, " "));
        if (!itemText) {
          continue;
        }
        const passageId = createReaderPassageId(passageIndex, `• ${itemText}`);
        passageIndex += 1;
        item.setAttribute("id", passageId);
        item.setAttribute("data-passage-id", passageId);
        passageIds.push(passageId);
      }
      blocks.push({
        kind: "list",
        html: element.outerHTML,
        text,
        wordCount: countWords(text),
        passageIds,
      });
      continue;
    }

    const passageId = createReaderPassageId(passageIndex, text);
    passageIndex += 1;
    if (tagName === "pre") {
      blocks.push({
        kind: "preformatted",
        html: renderPreformattedBlockHtml(passageId, text),
        text,
        wordCount: countWords(text),
        passageIds: [passageId],
      });
      continue;
    }
    element.setAttribute("id", passageId);
    element.setAttribute("data-passage-id", passageId);
    blocks.push({
      kind: tagName === "blockquote" ? "blockquote" : "paragraph",
      html: element.outerHTML,
      text,
      wordCount: countWords(text),
      passageIds: [passageId],
    });
  }

  return blocks.length > 0 ? blocks : buildPaginatedTextBlocks(document.body.textContent ?? "");
}

function buildPaginatedBookBlocks(rawSource: string, sourceFormat: "text" | "html") {
  return sourceFormat === "html" ? buildPaginatedHtmlBlocks(rawSource) : buildPaginatedTextBlocks(rawSource);
}

function chunkBlocksIntoPaginatedPages(blocks: PaginatedBookBlock[]) {
  const pages: PaginatedBookPage[] = [];
  let index = 0;
  let currentSectionTitle: string | null = null;

  while (index < blocks.length) {
    const pageBlocks: PaginatedBookBlock[] = [];
    let pageWordCount = 0;

    while (index < blocks.length) {
      const block = blocks[index];
      const projected = pageWordCount + block.wordCount;

      if (pageBlocks.length > 0 && pageWordCount >= PAGE_MIN_WORDS) {
        if (block.kind === "heading" || projected > PAGE_MAX_WORDS) {
          break;
        }
      }

      pageBlocks.push(block);
      pageWordCount = projected;
      index += 1;

      if (block.kind === "heading") {
        currentSectionTitle = block.sectionTitle ?? currentSectionTitle;
        if (index < blocks.length) {
          const nextBlock = blocks[index];
          pageBlocks.push(nextBlock);
          pageWordCount += nextBlock.wordCount;
          index += 1;
        }
      }

      if (pageWordCount >= PAGE_TARGET_WORDS && index < blocks.length) {
        const nextBlock = blocks[index];
        if (nextBlock.kind === "heading" || pageWordCount >= PAGE_MIN_WORDS) {
          break;
        }
      }
    }

    const passageIds = pageBlocks.flatMap((block) => block.passageIds);
    pages.push({
      pageNumber: pages.length + 1,
      href: createBookPageHref(pages.length + 1),
      wordCount: pageWordCount,
      sectionTitle: currentSectionTitle,
      firstPassageId: passageIds[0] ?? null,
      lastPassageId: passageIds.length > 0 ? passageIds[passageIds.length - 1] : null,
      blocks: pageBlocks,
    });
  }

  if (pages.length > 1) {
    const lastPage = pages[pages.length - 1];
    if (lastPage.wordCount < PAGE_TINY_MERGE_THRESHOLD) {
      const previousPage = pages[pages.length - 2];
      previousPage.blocks.push(...lastPage.blocks);
      previousPage.wordCount += lastPage.wordCount;
      previousPage.lastPassageId = lastPage.lastPassageId;
      pages.pop();
    }
  }

  return pages.map((page, index) => ({
    ...page,
    pageNumber: index + 1,
    href: createBookPageHref(index + 1),
  }));
}

function buildPaginatedBookArtifactBundle(input: {
  gutenbergId: string;
  title: string;
  subtitle?: string | null;
  authors: string[];
  bookshelves?: string[];
  summary?: string | null;
  language?: string | null;
  releaseDate?: string | null;
  rawSource: string;
  sourceFormat: "text" | "html";
}) {
  const meta = [
    input.gutenbergId ? `Project Gutenberg #${input.gutenbergId}` : null,
    input.language ? input.language.toUpperCase() : null,
    input.releaseDate ? input.releaseDate.slice(0, 4) : null,
  ].filter((value): value is string => Boolean(value)).join(" · ");
  const byline = input.authors.filter((author) => author.trim().length > 0).join(" · ");
  const blocks = buildPaginatedBookBlocks(input.rawSource, input.sourceFormat);
  const pages = chunkBlocksIntoPaginatedPages(blocks);
  const sections: PaginatedBookSection[] = [];
  const passageMap: Record<string, { pageNumber: number; href: string }> = {};

  for (const page of pages) {
    for (const block of page.blocks) {
      for (const passageId of block.passageIds) {
        passageMap[passageId] = {
          pageNumber: page.pageNumber,
          href: page.href,
        };
      }
      if (block.kind === "heading" && block.sectionTitle && block.passageIds[0]) {
        sections.push({
          id: block.sectionId ?? createBookSectionId(block.sectionTitle, sections.length),
          title: block.sectionTitle,
          href: page.href,
          pageNumber: page.pageNumber,
          passageId: block.passageIds[0],
        });
      }
    }
  }

  const landingHtml = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>${escapeHtml(input.title)} | alpha book</title>
    <meta name="description" content="${escapeHtml(createExcerpt(input.summary ?? input.rawSource ?? input.title))}" />
    <meta name="robots" content="noindex,nofollow" />
    <style>${renderBookStaticStyles()}</style>
  </head>
  <body>
    <main class="page-shell">
      <div class="surface">
        <section class="hero">
          ${meta ? `<p class="eyebrow">${escapeHtml(meta)}</p>` : ""}
          <h1>${escapeHtml(input.title)}</h1>
          ${input.subtitle ? `<p class="summary">${escapeHtml(input.subtitle)}</p>` : ""}
          ${byline ? `<p class="byline">${escapeHtml(byline)}</p>` : ""}
          ${input.summary ? `<p class="summary">${escapeHtml(input.summary)}</p>` : ""}
          ${renderTagList(input.bookshelves)}
        </section>
        ${pages[0] ? `<p><a class="page-link" href="${withBookVersion(pages[0].href)}"><strong>Start Reading</strong></a></p>` : ""}
        <section>
          <p class="toc-title">Contents</p>
          <ul class="toc-list">
            ${sections.map((section) => `
              <li>
                <a class="toc-link" href="${withBookVersion(section.href, section.passageId)}">${escapeHtml(section.title)} · Page ${section.pageNumber}</a>
              </li>
            `).join("")}
          </ul>
        </section>
    </main>
  </body>
</html>`;

  const pageFiles = pages.map((page) => {
    const previousPage = pages[page.pageNumber - 2] ?? null;
    const nextPage = pages[page.pageNumber] ?? null;
    const previousPageHref = previousPage ? withBookVersion(`./page-${String(previousPage.pageNumber).padStart(4, "0")}.html`) : null;
    const nextPageHref = nextPage ? withBookVersion(`./page-${String(nextPage.pageNumber).padStart(4, "0")}.html`) : null;
    const contentsHref = withBookVersion("../");
    const navLinks = [
      previousPageHref ? `<a class="nav-link" href="${previousPageHref}">Previous page</a>` : "",
      `<a class="nav-link" href="${contentsHref}">Contents</a>`,
      nextPageHref ? `<a class="nav-link" href="${nextPageHref}">Next page</a>` : "",
    ].filter(Boolean).join("");
    return {
      pageNumber: page.pageNumber,
      html: `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>${escapeHtml(input.title)} · Page ${page.pageNumber} | alpha book</title>
    <meta name="description" content="${escapeHtml(`Page ${page.pageNumber} of ${input.title}`)}" />
    <meta name="robots" content="noindex,nofollow" />
    ${previousPageHref ? `<link rel="prev" href="${previousPageHref}" />` : ""}
    ${nextPageHref ? `<link rel="next" href="${nextPageHref}" />` : ""}
    <style>${renderBookStaticStyles()}</style>
  </head>
  <body>
    <main class="page-shell">
        <nav class="page-nav">
          <div class="page-nav-links">${navLinks}</div>
          <p class="page-position">Page ${page.pageNumber} of ${pages.length}</p>
        </nav>
        <section class="hero">
          <h1>${escapeHtml(page.sectionTitle ?? input.title)}</h1>
          ${meta ? `<p class="page-meta">${escapeHtml(meta)}</p>` : ""}
        </section>
        <div class="reader-body">${page.blocks.map((block) => block.html).join("\n")}</div>
        <nav class="page-nav page-nav-bottom">
          <div class="page-nav-links">${navLinks}</div>
          <p class="page-position">Page ${page.pageNumber} of ${pages.length}</p>
        </nav>
        <script>${renderBookSelectionScript()}</script>
    </main>
  </body>
</html>`,
    };
  });

  return {
    landingHtml,
    manifestJson: JSON.stringify({
      gutenbergId: input.gutenbergId,
      title: input.title,
      pageCount: pages.length,
      pages: pages.map((page) => ({
        pageNumber: page.pageNumber,
        href: withBookVersion(page.href),
        firstPassageId: page.firstPassageId,
        lastPassageId: page.lastPassageId,
        sectionTitle: page.sectionTitle,
      })),
      sections,
      passages: passageMap,
    }, null, 2),
    pageFiles,
  };
}

function renderTextSource(content: string) {
  const paragraphs = gutenbergCorpusAdapter.text.stripSourceBoilerplate(content)
    .replace(/\r\n/g, "\n")
    .split(/\n{2,}/)
    .map((paragraph) => normalizeReaderText(paragraph, true))
    .filter((paragraph) => paragraph.length > 0);

  if (paragraphs.length === 0) {
    return `<p class="empty-state">This work does not have stored source content yet.</p>`;
  }

  return paragraphs
    .map((paragraph, index) => {
      const passageId = createReaderPassageId(index, paragraph);
      return `<p id="${passageId}" data-passage-id="${passageId}">${escapeHtml(paragraph).replace(/\n/g, "<br />")}</p>`;
    })
    .join("\n");
}

function renderAnchoredHtmlSource(content: string) {
  const sanitized = sanitizeSourceHtml(content);
  const { document } = parseHTML(`<!doctype html><html><body>${sanitized}</body></html>`);

  for (const node of Array.from(document.querySelectorAll("script, style, link, meta, base, noscript, iframe"))) {
    node.remove();
  }

  const selector = "h1, h2, h3, h4, h5, h6, p, li, blockquote, pre";
  const blocks = Array.from(document.body.querySelectorAll(selector)).filter((element) => !element.parentElement?.closest(selector));
  let passageIndex = 0;

  for (const element of blocks) {
    const tagName = element.tagName.toLowerCase();
    const rawText = tagName === "pre"
      ? element.textContent ?? ""
      : (element.textContent ?? "").replace(/\s+/g, " ");
    const text = normalizeReaderText(rawText, tagName === "pre");
    if (!text) {
      continue;
    }

    const passageText = tagName === "li" ? `• ${text}` : text;
    const passageId = createReaderPassageId(passageIndex, passageText);
    passageIndex += 1;
    element.setAttribute("id", passageId);
    element.setAttribute("data-passage-id", passageId);
  }

  return document.body.innerHTML;
}

function renderTagList(values: string[] | null | undefined) {
  const tags = (values ?? []).filter((value) => value.trim().length > 0).slice(0, 12);
  if (tags.length === 0) {
    return "";
  }
  return `<p class="meta-list">${tags.map((value) => `<span>${escapeHtml(value)}</span>`).join("")}</p>`;
}

async function getText(r2: S3Client, bucket: string, key: string): Promise<string | null> {
  const response = await r2.send(new GetObjectCommand({
    Bucket: bucket,
    Key: key,
  }));
  if (!response.Body) {
    return null;
  }
  return await response.Body.transformToString();
}

function shouldSkipExistingWork() {
  return process.env.FORCE_REINGEST !== "1";
}

async function findExistingWorkStatus(
  context: IngestContext,
  source: Pick<CorpusIngestSourceInput, "legacyNumericId" | "adapterId" | "externalId">,
): Promise<ExistingWorkStatus | null> {
  const rows = await context.db.query<{
    work_id: string;
    file_kind_count: number | string | null;
    chunk_count: number | string | null;
  }>(
    `
      SELECT
        w.id AS work_id,
        (
          SELECT COUNT(DISTINCT wf.kind)
          FROM work_files wf
          WHERE wf.work_id = w.id
            AND wf.kind IN ('raw', 'metadata', 'clean', 'chunks', 'book_html')
        ) AS file_kind_count,
        (
          SELECT COUNT(*)
          FROM chunks c
          WHERE c.work_id = w.id
        ) AS chunk_count
      FROM works w
      WHERE (
        ($1 IS NOT NULL AND w.gutenberg_id = $1)
        OR (
          $1 IS NULL
          AND json_extract(w.metadata_json, '$.corpusAdapterId') = $2
          AND json_extract(w.metadata_json, '$.externalId') = $3
        )
      )
      LIMIT 1
    `,
    [source.legacyNumericId ? Number(source.legacyNumericId) : null, source.adapterId, source.externalId],
  );
  const row = rows.rows[0];
  if (!row) {
    return null;
  }
  return {
    workId: row.work_id,
    complete: Number(row.file_kind_count) >= 5 && Number(row.chunk_count) > 0,
  };
}

async function upsertIngestedWork(
  context: IngestContext,
  source: CorpusIngestSourceInput,
  metadataPayload: Record<string, unknown>,
) {
  if (source.legacyNumericId) {
    const workResult = await context.db.query<{ id: string }>(
      `
        INSERT INTO works (id, gutenberg_id, title, language, release_date, rights_status, summary, metadata_json)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
        ON CONFLICT (gutenberg_id) DO UPDATE
        SET
          title = EXCLUDED.title,
          language = EXCLUDED.language,
          release_date = EXCLUDED.release_date,
          rights_status = EXCLUDED.rights_status,
          summary = EXCLUDED.summary,
          metadata_json = EXCLUDED.metadata_json,
          updated_at = CURRENT_TIMESTAMP
        RETURNING id
      `,
      [
        crypto.randomUUID(),
        Number(source.legacyNumericId),
        source.title,
        source.language ?? null,
        source.releaseDate ?? null,
        source.rightsStatus ?? null,
        source.summary ?? null,
        JSON.stringify(metadataPayload),
      ],
    );
    const workId = workResult.rows[0]?.id;
    if (!workId) {
      throw new Error(`Failed to resolve work id for ${source.adapterId}:${source.externalId}.`);
    }
    return workId;
  }

  const existing = await context.db.query<{ id: string }>(
      `
      SELECT id
      FROM works
      WHERE json_extract(metadata_json, '$.corpusAdapterId') = $1
        AND json_extract(metadata_json, '$.externalId') = $2
      LIMIT 1
    `,
    [source.adapterId, source.externalId],
  );
  const workId = existing.rows[0]?.id ?? crypto.randomUUID();
  if (existing.rows[0]?.id) {
    await context.db.query(
      `
        UPDATE works
        SET
          title = $2,
          language = $3,
          release_date = $4,
          rights_status = $5,
          summary = $6,
          metadata_json = $7,
          updated_at = CURRENT_TIMESTAMP
        WHERE id = $1
      `,
      [
        workId,
        source.title,
        source.language ?? null,
        source.releaseDate ?? null,
        source.rightsStatus ?? null,
        source.summary ?? null,
        JSON.stringify(metadataPayload),
      ],
    );
  } else {
    await context.db.query(
      `
        INSERT INTO works (id, gutenberg_id, title, language, release_date, rights_status, summary, metadata_json)
        VALUES ($1, NULL, $2, $3, $4, $5, $6, $7)
      `,
      [
        workId,
        source.title,
        source.language ?? null,
        source.releaseDate ?? null,
        source.rightsStatus ?? null,
        source.summary ?? null,
        JSON.stringify(metadataPayload),
      ],
    );
  }
  return workId;
}

async function putText(r2: S3Client, bucket: string, key: string, body: string, contentType: string) {
  await r2.send(
    new PutObjectCommand({
      Bucket: bucket,
      Key: key,
      Body: body,
      ContentType: contentType,
    }),
  );
}

async function putBytes(r2: S3Client, bucket: string, key: string, body: Uint8Array, contentType: string) {
  await r2.send(
    new PutObjectCommand({
      Bucket: bucket,
      Key: key,
      Body: body,
      ContentType: contentType,
    }),
  );
}

function coverContentType(path: string): string {
  if (/\.png$/i.test(path)) return "image/png";
  if (/\.webp$/i.test(path)) return "image/webp";
  return "image/jpeg";
}

function coverExtension(path: string): string {
  if (/\.png$/i.test(path)) return "png";
  if (/\.webp$/i.test(path)) return "webp";
  return "jpg";
}

async function deleteKeys(r2: S3Client, bucket: string, keys: string[]) {
  const uniqueKeys = [...new Set(keys.filter(Boolean))];
  if (uniqueKeys.length === 0) {
    return;
  }

  for (let index = 0; index < uniqueKeys.length; index += 1000) {
    const batch = uniqueKeys.slice(index, index + 1000);
    await r2.send(
      new DeleteObjectsCommand({
        Bucket: bucket,
        Delete: {
          Objects: batch.map((Key) => ({ Key })),
          Quiet: true,
        },
      }),
    );
  }
}

async function syncAuthors(context: IngestContext, workId: string, authors: string[]) {
  const normalizedAuthors = uniqueStrings(authors);
  await context.db.query(`DELETE FROM work_authors WHERE work_id = $1`, [workId]);

  for (const authorName of normalizedAuthors) {
    const existing = await context.db.query<{ id: string }>(
      `SELECT id FROM authors WHERE lower(name) = lower($1) LIMIT 1`,
      [authorName],
    );
    const authorId = existing.rows[0]?.id ?? crypto.randomUUID();
    if (!existing.rows[0]?.id) {
      await context.db.query(
        `INSERT INTO authors (id, name, sort_name, created_at) VALUES ($1, $2, $3, CURRENT_TIMESTAMP)`,
        [authorId, authorName, authorName],
      );
    }
    await context.db.query(
      `INSERT INTO work_authors (work_id, author_id) VALUES ($1, $2) ON CONFLICT DO NOTHING`,
      [workId, authorId],
    );
  }
}

async function syncSubjects(context: IngestContext, workId: string, subjects: string[]) {
  const normalizedSubjects = uniqueStrings(subjects);
  await context.db.query(`DELETE FROM work_subjects WHERE work_id = $1`, [workId]);

  for (const subjectLabel of normalizedSubjects) {
    const existing = await context.db.query<{ id: string }>(
      `SELECT id FROM subjects WHERE label = $1 LIMIT 1`,
      [subjectLabel],
    );
    const subjectId = existing.rows[0]?.id ?? crypto.randomUUID();
    if (!existing.rows[0]?.id) {
      await context.db.query(
        `INSERT INTO subjects (id, label) VALUES ($1, $2) ON CONFLICT (label) DO NOTHING`,
        [subjectId, subjectLabel],
      );
    }
    const resolved = existing.rows[0]?.id
      ? subjectId
      : (
          await context.db.query<{ id: string }>(
            `SELECT id FROM subjects WHERE label = $1 LIMIT 1`,
            [subjectLabel],
          )
        ).rows[0]?.id;
    if (resolved) {
      await context.db.query(
        `INSERT INTO work_subjects (work_id, subject_id) VALUES ($1, $2) ON CONFLICT DO NOTHING`,
        [workId, resolved],
      );
    }
  }
}

function buildRenderedArtifactsForSource(
  source: CorpusIngestSourceInput,
): RenderedArtifactBundle | null {
  if (source.adapterId === gutenbergCorpusAdapter.id && source.legacyNumericId) {
    return buildPaginatedBookArtifactBundle({
      gutenbergId: source.legacyNumericId,
      title: source.title,
      subtitle: typeof source.metadata?.subtitle === "string" ? source.metadata.subtitle : null,
      authors: source.authors ?? [],
      bookshelves: Array.isArray(source.metadata?.bookshelves)
        ? source.metadata.bookshelves.filter((value): value is string => typeof value === "string")
        : [],
      summary: source.summary ?? null,
      language: source.language ?? null,
      releaseDate: source.releaseDate ?? null,
      rawSource: source.rawSource,
      sourceFormat: source.sourceFormat ?? "text",
    });
  }
  return buildSimpleRenderedArtifactBundle({
    externalId: source.externalId,
    title: source.title,
    authors: source.authors ?? [],
    summary: source.summary ?? null,
    cleanText: source.rawText,
  });
}

async function persistIngestedWork(
  context: IngestContext,
  adapter: CorpusAdapter,
  source: CorpusIngestSourceInput,
) {
  if (shouldSkipExistingWork()) {
    const existing = await findExistingWorkStatus(context, source);
    if (existing?.complete) {
      return {
        workId: existing.workId,
        externalId: source.externalId,
        corpusAdapterId: source.adapterId,
        title: source.title,
        skipped: true,
        reason: "already_ingested",
      };
    }
  }

  const prepared = prepareCorpusIngest(adapter, {
    ...source,
    renderedArtifacts: buildRenderedArtifactsForSource(source),
  });
  const cleanText = prepared.cleanText;
  const chunks = prepared.chunks;
  const chunkEmbeddings = await embedChunks(chunks);
  const chunkIds = chunks.map(() => crypto.randomUUID());
  const authors = prepared.authors;
  const subjects = prepared.subjects;

  const rawKey = prepared.rawKey;
  const metadataKey = prepared.metadataKey;
  const cleanKey = prepared.cleanKey;
  const chunksKey = prepared.chunksKey;
  const renderedDocumentKey = prepared.renderedDocumentKey ?? "";
  const coverImagePath = typeof source.metadata?.coverImagePath === "string" ? source.metadata.coverImagePath : null;
  const coverImageKey = coverImagePath
    ? adapter.artifactKeys.coverImage?.(source.externalId, coverExtension(coverImagePath)) ?? null
    : null;
  const metadataPayload = {
    ...prepared.metadataPayload,
    subtitle: typeof source.metadata?.subtitle === "string" ? source.metadata.subtitle : null,
    coverImageKey,
  };
  const workId = await upsertIngestedWork(context, source, metadataPayload);

  const chunksPayload = chunks
    .map((chunk, index) =>
      JSON.stringify({
        id: chunkIds[index],
        work_id: workId,
        chunk_index: index,
        text: chunk,
        r2_key: chunksKey,
        embedding_dimensions: chunkEmbeddings?.[index]?.length ?? null,
      }),
    )
    .join("\n");
  const renderedArtifacts = prepared.renderedArtifacts;
  const renderedManifestKey = prepared.renderedManifestKey ?? "";

  await Promise.all([
    putText(
      context.r2,
      context.r2Bucket,
      rawKey,
      source.rawSource,
      source.sourceFormat === "html" ? "text/html; charset=utf-8" : "text/plain; charset=utf-8",
    ),
    putText(
      context.r2,
      context.r2Bucket,
      metadataKey,
      JSON.stringify(metadataPayload, null, 2),
      "application/json",
    ),
    putText(context.r2, context.r2Bucket, cleanKey, cleanText, "text/plain; charset=utf-8"),
    putText(context.r2, context.r2Bucket, chunksKey, chunksPayload, "application/x-ndjson"),
    ...(renderedArtifacts && renderedDocumentKey
      ? [putText(context.r2, context.r2Bucket, renderedDocumentKey, renderedArtifacts.landingHtml, "text/html; charset=utf-8")]
      : []),
    ...(renderedArtifacts && renderedManifestKey
      ? [putText(context.r2, context.r2Bucket, renderedManifestKey, renderedArtifacts.manifestJson, "application/json; charset=utf-8")]
      : []),
    ...(renderedArtifacts
      ? renderedArtifacts.pageFiles.map((page) =>
          putText(
            context.r2,
            context.r2Bucket,
            adapter.artifactKeys.renderedPage?.(source.externalId, page.pageNumber) ?? "",
            page.html,
            "text/html; charset=utf-8",
          ))
      : []),
    ...(coverImagePath && coverImageKey
      ? [
          readFile(coverImagePath).then((bytes) =>
            putBytes(context.r2, context.r2Bucket, coverImageKey, bytes, coverContentType(coverImagePath)),
          ),
        ]
      : []),
  ]);

  await context.db.query(
    `
      INSERT INTO work_files (id, work_id, kind, r2_key, metadata_json)
      VALUES
        ($1, $2, 'raw', $3, '{}'),
        ($4, $2, 'metadata', $5, '{}'),
        ($6, $2, 'clean', $7, '{}'),
        ($8, $2, 'chunks', $9, '{}'),
        ($10, $2, 'book_html', $11, '{}')
      ON CONFLICT (r2_key) DO NOTHING
    `,
    [
      crypto.randomUUID(),
      workId,
      rawKey,
      crypto.randomUUID(),
      metadataKey,
      crypto.randomUUID(),
      cleanKey,
      crypto.randomUUID(),
      chunksKey,
      crypto.randomUUID(),
      renderedDocumentKey,
    ],
  );

  for (const [index, chunk] of chunks.entries()) {
    await context.db.query(
      `
        INSERT INTO chunks (id, work_id, chunk_index, text, r2_key, metadata_json, created_at)
        VALUES ($1, $2, $3, $4, $5, $6, CURRENT_TIMESTAMP)
        ON CONFLICT (work_id, chunk_index) DO UPDATE
        SET
          text = EXCLUDED.text,
          r2_key = EXCLUDED.r2_key,
          metadata_json = EXCLUDED.metadata_json
      `,
      [
        chunkIds[index]!,
        workId,
        index,
        chunk,
        chunksKey,
        JSON.stringify({
          embeddingProvider: process.env.EMBEDDING_PROVIDER ?? "openai",
          embeddingModel: process.env.EMBEDDING_PROVIDER === "google"
            ? (process.env.GOOGLE_EMBEDDING_MODEL ?? "gemini-embedding-2-preview")
            : (process.env.OPENAI_EMBEDDING_MODEL ?? "text-embedding-3-small"),
          embeddingDimensions: chunkEmbeddings?.[index]?.length ?? null,
        }),
      ],
    );
  }

  await upsertChunkVectors(
    context,
    chunkEmbeddings
      ? chunkEmbeddings.map((values, index) => ({
          id: chunkIds[index]!,
          values,
          metadata: {
            workId,
            chunkIndex: index,
            adapterId: source.adapterId,
            externalId: source.externalId,
            language: source.language ?? null,
            rightsStatus: source.rightsStatus ?? null,
          },
        }))
      : [],
  );

  await syncAuthors(context, workId, authors);
  await syncSubjects(context, workId, subjects);

  return {
    workId,
    externalId: source.externalId,
    corpusAdapterId: source.adapterId,
    title: source.title,
    chunkCount: chunks.length,
    rawKey,
    cleanKey,
    chunksKey,
    renderedDocumentKey,
    skipped: false,
  };
}

async function readCheckpoint(path: string): Promise<MirrorBackfillCheckpoint | null> {
  try {
    const raw = await readFile(path, "utf8");
    const parsed = JSON.parse(raw) as Partial<MirrorBackfillCheckpoint>;
    if (typeof parsed.lastProcessedId !== "string" && parsed.lastProcessedId !== null) {
      return null;
    }
    return {
      lastProcessedId: parsed.lastProcessedId ?? null,
      processed: typeof parsed.processed === "number" ? parsed.processed : 0,
      updatedAt: typeof parsed.updatedAt === "string" ? parsed.updatedAt : new Date().toISOString(),
    };
  } catch {
    return null;
  }
}

async function writeCheckpoint(path: string, checkpoint: MirrorBackfillCheckpoint) {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, JSON.stringify(checkpoint, null, 2), "utf8");
}

async function ingestUrl(context: IngestContext, gutenbergId: string, sourceUrl: string, title: string) {
  const response = await fetch(sourceUrl);
  if (!response.ok) {
    throw new Error(`Failed to fetch source URL: ${response.status}`);
  }
  const rawText = await response.text();
  return persistIngestedWork(context, gutenbergCorpusAdapter, {
    adapterId: gutenbergCorpusAdapter.id,
    externalId: gutenbergId,
    legacyNumericId: gutenbergId,
    title,
    rawSource: rawText,
    rawText,
    sourceFormat: /html/i.test(response.headers.get("content-type") ?? "") || /\.html?$/i.test(sourceUrl) ? "html" : "text",
    sourceUrl,
    metadata: {
      source: "remote-url",
    },
  });
}

async function ingestFromMirror(context: IngestContext, gutenbergId: string, explicitTitle?: string) {
  const mirrorRoot = process.env.GUTENBERG_MIRROR_ROOT;
  if (!mirrorRoot) {
    throw new Error("GUTENBERG_MIRROR_ROOT is required for ingest-gutenberg.");
  }
  const source = await resolveMirrorSource(mirrorRoot, gutenbergId);
  return persistIngestedWork(context, gutenbergCorpusAdapter, {
    adapterId: gutenbergCorpusAdapter.id,
    externalId: gutenbergId,
    legacyNumericId: gutenbergId,
    title: explicitTitle ?? source.title ?? `Project Gutenberg ${gutenbergId}`,
    rawSource: source.rawSource,
    rawText: source.rawText,
    sourceFormat: source.format,
    authors: source.authors,
    subjects: source.subjects,
    language: source.language,
    releaseDate: source.releaseDate,
    rightsStatus: source.rightsStatus,
    summary: source.summary,
    sourcePath: source.sourcePath,
    metadata: {
      source: "local-mirror",
      mirrorRoot,
      metadataPath: source.metadataPath,
      format: source.format,
      subtitle: source.subtitle,
      bookshelves: source.bookshelves,
      publisher: source.publisher,
      translators: source.translators,
      illustrators: source.illustrators,
      editors: source.editors,
      coverImagePath: source.coverImagePath,
      ...source.metadata,
    },
  });
}

async function ingestFixtureDocument(context: IngestContext, documentId?: string) {
  const selected = documentId
    ? fixtureDocuments.filter((document) => document.id === documentId)
    : fixtureDocuments;
  if (selected.length === 0) {
    throw new Error(`Unknown fixture document: ${documentId}`);
  }
  const results = [];
  for (const document of selected) {
    const rawSource = fixtureDocumentSources[document.id];
    if (!rawSource) {
      throw new Error(`Missing fixture source text for ${document.id}`);
    }
    results.push(await persistIngestedWork(context, fixtureCorpusAdapter, {
      adapterId: fixtureCorpusAdapter.id,
      externalId: document.id,
      title: document.title,
      rawSource,
      rawText: rawSource,
      sourceFormat: "text",
      authors: [...document.contributors],
      subjects: [...document.subjects],
      language: document.language ?? null,
      rightsStatus: document.rightsStatus ?? null,
      summary: document.summary ?? null,
      metadata: {
        ...document.metadata,
        source: "fixture-corpus",
      },
    }));
  }
  return {
    corpusAdapterId: fixtureCorpusAdapter.id,
    inserted: results.length,
    results,
  };
}

function buildLocalPreviewResult(
  adapter: CorpusAdapter,
  source: CorpusIngestSourceInput,
) {
  const prepared = prepareCorpusIngest(adapter, {
    ...source,
    renderedArtifacts: buildRenderedArtifactsForSource(source),
  });

  return {
    externalId: source.externalId,
    corpusAdapterId: source.adapterId,
    title: source.title,
    chunkCount: prepared.chunks.length,
    rawKey: prepared.rawKey,
    metadataKey: prepared.metadataKey,
    cleanKey: prepared.cleanKey,
    chunksKey: prepared.chunksKey,
    renderedDocumentKey: prepared.renderedDocumentKey,
    renderedManifestKey: prepared.renderedManifestKey,
    sampleChunk: prepared.chunks[0] ?? null,
    metadataPayload: prepared.metadataPayload,
  };
}

async function previewFixtureDocument(documentId?: string) {
  const selected = documentId
    ? fixtureDocuments.filter((document) => document.id === documentId)
    : fixtureDocuments;
  if (selected.length === 0) {
    throw new Error(`Unknown fixture document: ${documentId}`);
  }

  return {
    corpusAdapterId: fixtureCorpusAdapter.id,
    previewOnly: true,
    results: selected.map((document) => {
      const rawSource = fixtureDocumentSources[document.id];
      if (!rawSource) {
        throw new Error(`Missing fixture source text for ${document.id}`);
      }
      return buildLocalPreviewResult(fixtureCorpusAdapter, {
        adapterId: fixtureCorpusAdapter.id,
        externalId: document.id,
        title: document.title,
        rawSource,
        rawText: rawSource,
        sourceFormat: "text",
        authors: [...document.contributors],
        subjects: [...document.subjects],
        language: document.language ?? null,
        rightsStatus: document.rightsStatus ?? null,
        summary: document.summary ?? null,
        metadata: {
          ...document.metadata,
          source: "fixture-corpus",
        },
      });
    }),
  };
}

async function ingestSupremeCourtDemo(context: IngestContext, documentId?: string) {
  const selected = documentId
    ? supremeCourtCases.filter((document) => document.id === documentId)
    : supremeCourtCases;
  if (selected.length === 0) {
    throw new Error(`Unknown supreme court demo case: ${documentId}`);
  }
  const results = [];
  for (const document of selected) {
    const rawSource = supremeCourtCaseSources[document.id];
    if (!rawSource) {
      throw new Error(`Missing supreme court source text for ${document.id}`);
    }
    results.push(await persistIngestedWork(context, supremeCourtCorpusAdapter, {
      adapterId: supremeCourtCorpusAdapter.id,
      externalId: document.id,
      title: document.title,
      rawSource,
      rawText: rawSource,
      sourceFormat: "text",
      authors: [...document.contributors],
      subjects: [...document.subjects],
      language: document.language ?? null,
      rightsStatus: document.rightsStatus ?? null,
      releaseDate: document.publishedAt ?? null,
      summary: document.summary ?? null,
      metadata: {
        ...document.metadata,
        source: "supreme-court-demo",
      },
    }));
  }
  return {
    corpusAdapterId: supremeCourtCorpusAdapter.id,
    inserted: results.length,
    results,
  };
}

async function previewSupremeCourtDemo(documentId?: string) {
  const selected = documentId
    ? supremeCourtCases.filter((document) => document.id === documentId)
    : supremeCourtCases;
  if (selected.length === 0) {
    throw new Error(`Unknown supreme court demo case: ${documentId}`);
  }

  return {
    corpusAdapterId: supremeCourtCorpusAdapter.id,
    previewOnly: true,
    results: selected.map((document) => {
      const rawSource = supremeCourtCaseSources[document.id];
      if (!rawSource) {
        throw new Error(`Missing supreme court source text for ${document.id}`);
      }
      return buildLocalPreviewResult(supremeCourtCorpusAdapter, {
        adapterId: supremeCourtCorpusAdapter.id,
        externalId: document.id,
        title: document.title,
        rawSource,
        rawText: rawSource,
        sourceFormat: "text",
        authors: [...document.contributors],
        subjects: [...document.subjects],
        language: document.language ?? null,
        rightsStatus: document.rightsStatus ?? null,
        releaseDate: document.publishedAt ?? null,
        summary: document.summary ?? null,
        metadata: {
          ...document.metadata,
          source: "supreme-court-demo",
        },
      });
    }),
  };
}

function buildCourtListenerCaseLawClient() {
  const authToken = process.env.COURTLISTENER_API_TOKEN;
  if (!authToken) {
    throw new Error("COURTLISTENER_API_TOKEN is required for Supreme Court backfill.");
  }
  return new CourtListenerCaseLawClient(authToken);
}

async function ingestSupremeCourtCluster(
  context: IngestContext,
  clusterId: number,
  client = buildCourtListenerCaseLawClient(),
) {
  const cluster = await client.getCluster(clusterId);
  const opinions = await client.getClusterOpinions(cluster);
  const source = buildSupremeCourtCaseSource(cluster, opinions);
  return persistIngestedWork(context, supremeCourtCorpusAdapter, {
    adapterId: supremeCourtCorpusAdapter.id,
    externalId: source.externalId,
    title: source.title,
    rawSource: source.rawSource,
    rawText: source.rawText,
    sourceFormat: source.sourceFormat,
    authors: source.authors,
    subjects: source.subjects,
    language: "en",
    rightsStatus: source.rightsStatus,
    releaseDate: source.releaseDate,
    summary: source.summary,
    sourceUrl: source.sourceUrl ?? undefined,
    metadata: source.metadata,
  });
}

async function countSupremeCourtCases(startAfterId?: number | null) {
  const client = buildCourtListenerCaseLawClient();
  const count = await client.countSupremeCourtClusters(startAfterId ?? null);
  return {
    source: "courtlistener-api",
    court: "scotus",
    startAfterId: startAfterId ?? null,
    count,
  };
}

async function backfillSupremeCourt(context: IngestContext, options: SupremeCourtBackfillOptions) {
  const client = buildCourtListenerCaseLawClient();
  const results: Array<Record<string, unknown>> = [];
  let processed = 0;
  let inserted = 0;
  let skipped = 0;
  let errors = 0;
  let nextUrl: string | null = null;
  let nextStartAfterId = options.startAfterId ?? null;

  while (processed < options.limit) {
    const page = await client.listSupremeCourtClustersPage({
      nextUrl,
      startAfterId: nextUrl ? undefined : nextStartAfterId,
    });
    if (!page.results.length) {
      break;
    }

    for (const cluster of page.results) {
      if (processed >= options.limit) {
        break;
      }
      processed += 1;
      nextStartAfterId = cluster.id;
      try {
        const result = await ingestSupremeCourtCluster(context, cluster.id, client);
        results.push(result);
        if (result.skipped) {
          skipped += 1;
        } else {
          inserted += 1;
        }
      } catch (error) {
        errors += 1;
        results.push({
          clusterId: cluster.id,
          title: cluster.case_name_full ?? cluster.case_name ?? `Cluster ${cluster.id}`,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }

    nextUrl = page.next;
    if (!nextUrl) {
      break;
    }
  }

  return {
    source: "courtlistener-api",
    court: "scotus",
    startAfterId: options.startAfterId ?? null,
    processed,
    inserted,
    skipped,
    errors,
    nextStartAfterId,
    results,
  };
}

async function deleteGutenbergWorks(context: IngestContext, gutenbergIds: string[]) {
  const ids = [...new Set(gutenbergIds.map((id) => id.trim()).filter(Boolean))];
  if (ids.length === 0) {
    return { deleted: 0, ids: [], r2KeysDeleted: 0 };
  }

  const idList = ids.map((id) => Number(id)).filter((id) => Number.isFinite(id));
  const placeholders = idList.map((_, index) => `$${index + 1}`).join(", ");
  if (idList.length === 0) {
    return { deleted: 0, ids: [], r2KeysDeleted: 0 };
  }

  const rows = await context.db.query<{ gutenberg_id: number | string | null; r2_key: string | null }>(
    `
      SELECT w.gutenberg_id, wf.r2_key
      FROM works w
      LEFT JOIN work_files wf ON wf.work_id = w.id
      WHERE w.gutenberg_id IN (${placeholders})
    `,
    idList,
  );

  const r2Keys = uniqueStrings([
    ...rows.rows.map((row) => (row.r2_key ? String(row.r2_key) : null)),
    ...ids.flatMap((id) => [
      gutenbergCorpusAdapter.artifactKeys.rawText(id),
      gutenbergCorpusAdapter.artifactKeys.rawMetadata(id),
      gutenbergCorpusAdapter.artifactKeys.cleanText(id),
      gutenbergCorpusAdapter.artifactKeys.chunks(id),
      gutenbergCorpusAdapter.artifactKeys.renderedDocument?.(id) ?? "",
    ]),
  ]);

  await deleteKeys(context.r2, context.r2Bucket, r2Keys);
  await context.db.query(`DELETE FROM works WHERE gutenberg_id IN (${placeholders})`, idList);
  await context.db.query(`DELETE FROM authors a WHERE NOT EXISTS (SELECT 1 FROM work_authors wa WHERE wa.author_id = a.id)`);
  await context.db.query(`DELETE FROM subjects s WHERE NOT EXISTS (SELECT 1 FROM work_subjects ws WHERE ws.subject_id = s.id)`);

  return {
    deleted: ids.length,
    ids,
    r2KeysDeleted: r2Keys.length,
  };
}

async function listWorksMissingBookHtml(context: IngestContext, limit: number, startAfterGutenbergId?: string | null) {
  const rows = await context.db.query<{
    work_id: string;
    gutenberg_id: string | number;
    title: string;
    summary: string | null;
    language: string | null;
    release_date: string | null;
    metadata_json: Record<string, unknown> | null;
  }>(
    `
      SELECT
        w.id AS work_id,
        CAST(w.gutenberg_id AS TEXT) AS gutenberg_id,
        w.title,
        w.summary,
        w.language,
        w.release_date AS release_date,
        w.metadata_json
      FROM works w
      LEFT JOIN work_files html_file
        ON html_file.work_id = w.id
       AND html_file.kind = 'book_html'
      WHERE w.gutenberg_id IS NOT NULL
        AND html_file.id IS NULL
        AND ($1 IS NULL OR w.gutenberg_id > $1)
      ORDER BY w.gutenberg_id ASC
      LIMIT $2
    `,
    [startAfterGutenbergId ? Number(startAfterGutenbergId) : null, limit],
  );

  return rows.rows.map((row) => ({
    workId: row.work_id,
    gutenbergId: String(row.gutenberg_id),
    title: row.title,
    summary: row.summary,
    language: row.language,
    releaseDate: row.release_date,
    metadata: row.metadata_json ?? {},
  } satisfies ExistingBookHtmlWork));
}

async function listBookHtmlWorks(context: IngestContext, limit: number, startAfterGutenbergId?: string | null) {
  const rows = await context.db.query<{
    work_id: string;
    gutenberg_id: string;
    title: string;
    summary: string | null;
    language: string | null;
    release_date: string | null;
    metadata_json: Record<string, unknown> | null;
  }>(
    `
      SELECT
        w.id AS work_id,
        CAST(w.gutenberg_id AS TEXT) AS gutenberg_id,
        w.title,
        w.summary,
        w.language,
        w.release_date AS release_date,
        w.metadata_json
      FROM works w
      WHERE w.gutenberg_id IS NOT NULL
        AND ($1 IS NULL OR w.gutenberg_id > $1)
      ORDER BY w.gutenberg_id ASC
      LIMIT $2
    `,
    [startAfterGutenbergId ? Number(startAfterGutenbergId) : null, limit],
  );

  return rows.rows.map((row) => ({
    workId: row.work_id,
    gutenbergId: String(row.gutenberg_id),
    title: row.title,
    summary: row.summary,
    language: row.language,
    releaseDate: row.release_date,
    metadata: row.metadata_json ?? {},
  } satisfies ExistingBookHtmlWork));
}

async function listBookHtmlWorksByCreatedAt(
  context: IngestContext,
  limit: number,
  createdAtFrom: string,
  createdAtTo: string,
  startAfterGutenbergId?: string | null,
) {
  const rows = await context.db.query<{
    work_id: string;
    gutenberg_id: string;
    title: string;
    summary: string | null;
    language: string | null;
    release_date: string | null;
    metadata_json: Record<string, unknown> | null;
  }>(
    `
      SELECT
        w.id AS work_id,
        CAST(w.gutenberg_id AS TEXT) AS gutenberg_id,
        w.title,
        w.summary,
        w.language,
        w.release_date AS release_date,
        w.metadata_json
      FROM works w
      WHERE w.gutenberg_id IS NOT NULL
        AND w.created_at >= $1
        AND w.created_at < $2
        AND ($3 IS NULL OR w.gutenberg_id > $3)
      ORDER BY w.gutenberg_id ASC
      LIMIT $4
    `,
    [createdAtFrom, createdAtTo, startAfterGutenbergId ? Number(startAfterGutenbergId) : null, limit],
  );

  return rows.rows.map((row) => ({
    workId: row.work_id,
    gutenbergId: String(row.gutenberg_id),
    title: row.title,
    summary: row.summary,
    language: row.language,
    releaseDate: row.release_date,
    metadata: row.metadata_json ?? {},
  } satisfies ExistingBookHtmlWork));
}

async function persistBookHtmlArtifact(
  context: IngestContext,
  work: ExistingBookHtmlWork,
  rawKey?: string | null,
): Promise<BookHtmlPersistResult> {
  const candidateKeys = uniqueStrings([
    rawKey,
    gutenbergCorpusAdapter.artifactKeys.rawText(work.gutenbergId),
    gutenbergCorpusAdapter.artifactKeys.cleanText(work.gutenbergId),
  ]);
  let rawSource: string | null = null;
  let resolvedSourceKey: string | null = null;
  for (const candidateKey of candidateKeys) {
    rawSource = await getText(context.r2, context.r2Bucket, candidateKey);
    if (rawSource) {
      resolvedSourceKey = candidateKey;
      break;
    }
  }
  if (!rawSource || !resolvedSourceKey) {
    return {
      workId: work.workId,
      gutenbergId: work.gutenbergId,
      skipped: true,
      error: `Missing source artifact for Gutenberg ${work.gutenbergId}. Tried: ${candidateKeys.join(", ")}`,
    };
  }
  const metadata = work.metadata ?? {};
  const bookBundle = buildPaginatedBookArtifactBundle({
    gutenbergId: work.gutenbergId,
    title: work.title,
    subtitle: typeof metadata.subtitle === "string" ? metadata.subtitle : null,
    authors: Array.isArray(metadata.authors) ? metadata.authors.filter((value): value is string => typeof value === "string") : [],
    bookshelves: Array.isArray(metadata.bookshelves) ? metadata.bookshelves.filter((value): value is string => typeof value === "string") : [],
    summary: work.summary ?? null,
    language: work.language ?? null,
    releaseDate: work.releaseDate ?? null,
    rawSource,
    sourceFormat: resolvedSourceKey.endsWith("/raw.txt") && metadata.sourceFormat === "html" ? "html" : "text",
  });
  const bookHtmlKey = gutenbergCorpusAdapter.artifactKeys.renderedDocument?.(work.gutenbergId) ?? "";
  const bookManifestKey = gutenbergCorpusAdapter.artifactKeys.renderedManifest?.(work.gutenbergId) ?? "";

  await Promise.all([
    putText(context.r2, context.r2Bucket, bookHtmlKey, bookBundle.landingHtml, "text/html; charset=utf-8"),
    putText(context.r2, context.r2Bucket, bookManifestKey, bookBundle.manifestJson, "application/json; charset=utf-8"),
    ...bookBundle.pageFiles.map((page) =>
      putText(
        context.r2,
        context.r2Bucket,
        gutenbergCorpusAdapter.artifactKeys.renderedPage?.(work.gutenbergId, page.pageNumber) ?? "",
        page.html,
        "text/html; charset=utf-8",
      )),
  ]);
  await context.db.query(
    `
      INSERT INTO work_files (id, work_id, kind, r2_key, metadata_json)
      VALUES ($1, $2, 'book_html', $3, '{}')
      ON CONFLICT (r2_key) DO NOTHING
    `,
    [crypto.randomUUID(), work.workId, bookHtmlKey],
  );

  return {
    workId: work.workId,
    gutenbergId: work.gutenbergId,
    bookHtmlKey,
  };
}

async function backfillBookHtml(
  context: IngestContext,
  options: { startAfterId?: string | null; limit: number; concurrency?: number },
) {
  const works = await listWorksMissingBookHtml(context, options.limit, options.startAfterId ?? null);
  const results: BookHtmlPersistResult[] = [];
  const errors: Array<Record<string, unknown>> = [];

  const concurrency = Math.max(1, Number(options.concurrency ?? process.env.BOOK_HTML_BACKFILL_CONCURRENCY ?? "8"));
  let cursor = 0;

  async function worker() {
    while (cursor < works.length) {
      const work = works[cursor++];
      try {
        const result = await persistBookHtmlArtifact(context, work);
        if (result.error) {
          errors.push({
            gutenbergId: work.gutenbergId,
            error: result.error,
          });
          console.error(JSON.stringify({
            phase: "book-html-backfill-error",
            gutenbergId: work.gutenbergId,
            error: result.error,
          }));
          continue;
        }
        results.push(result);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        errors.push({
          gutenbergId: work.gutenbergId,
          error: message,
        });
        console.error(JSON.stringify({
          phase: "book-html-backfill-error",
          gutenbergId: work.gutenbergId,
          error: message,
        }));
      }
    }
  }

  await Promise.all(Array.from({ length: Math.min(concurrency, works.length || 1) }, () => worker()));

  return {
    processed: results.length + errors.length,
    inserted: results.length,
    errors,
    nextStartAfterId: works.length > 0 ? works[works.length - 1].gutenbergId : options.startAfterId ?? null,
    results,
  };
}

async function rebuildBookHtml(
  context: IngestContext,
  options: { startAfterId?: string | null; limit: number; concurrency?: number },
) {
  const works = await listBookHtmlWorks(context, options.limit, options.startAfterId ?? null);
  const results: BookHtmlPersistResult[] = [];
  const errors: Array<Record<string, unknown>> = [];

  const concurrency = Math.max(1, Number(options.concurrency ?? process.env.BOOK_HTML_REBUILD_CONCURRENCY ?? "8"));
  let cursor = 0;

  async function worker() {
    while (cursor < works.length) {
      const work = works[cursor++];
      try {
        const result = await persistBookHtmlArtifact(context, work);
        if (result.error) {
          errors.push({
            gutenbergId: work.gutenbergId,
            error: result.error,
          });
          console.error(JSON.stringify({
            phase: "book-html-rebuild-error",
            gutenbergId: work.gutenbergId,
            error: result.error,
          }));
          continue;
        }
        results.push(result);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        errors.push({
          gutenbergId: work.gutenbergId,
          error: message,
        });
        console.error(JSON.stringify({
          phase: "book-html-rebuild-error",
          gutenbergId: work.gutenbergId,
          error: message,
        }));
      }
    }
  }

  await Promise.all(Array.from({ length: Math.min(concurrency, works.length || 1) }, () => worker()));

  return {
    processed: results.length + errors.length,
    inserted: results.length,
    errors,
    nextStartAfterId: works.length > 0 ? works[works.length - 1].gutenbergId : options.startAfterId ?? null,
    results,
  };
}

async function rebuildBookHtmlByCreatedAt(
  context: IngestContext,
  options: {
    createdAtFrom: string;
    createdAtTo: string;
    startAfterId?: string | null;
    limit: number;
    concurrency?: number;
  },
) {
  const works = await listBookHtmlWorksByCreatedAt(
    context,
    options.limit,
    options.createdAtFrom,
    options.createdAtTo,
    options.startAfterId ?? null,
  );
  const results: BookHtmlPersistResult[] = [];
  const errors: Array<Record<string, unknown>> = [];

  const concurrency = Math.max(1, Number(options.concurrency ?? process.env.BOOK_HTML_REBUILD_CONCURRENCY ?? "8"));
  let cursor = 0;

  async function worker() {
    while (cursor < works.length) {
      const work = works[cursor++];
      try {
        const result = await persistBookHtmlArtifact(context, work);
        if (result.error) {
          errors.push({
            gutenbergId: work.gutenbergId,
            error: result.error,
          });
          console.error(JSON.stringify({
            phase: "book-html-rebuild-created-at-error",
            gutenbergId: work.gutenbergId,
            error: result.error,
          }));
          continue;
        }
        results.push(result);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        errors.push({
          gutenbergId: work.gutenbergId,
          error: message,
        });
        console.error(JSON.stringify({
          phase: "book-html-rebuild-created-at-error",
          gutenbergId: work.gutenbergId,
          error: message,
        }));
      }
    }
  }

  await Promise.all(Array.from({ length: Math.min(concurrency, works.length || 1) }, () => worker()));

  return {
    createdAtFrom: options.createdAtFrom,
    createdAtTo: options.createdAtTo,
    processed: results.length + errors.length,
    inserted: results.length,
    errors,
    nextStartAfterId: works.length > 0 ? works[works.length - 1].gutenbergId : options.startAfterId ?? null,
    results,
  };
}

async function backfillMirror(context: IngestContext, options: MirrorBackfillOptions) {
  const mirrorRoot = process.env.GUTENBERG_MIRROR_ROOT;
  if (!mirrorRoot) {
    throw new Error("GUTENBERG_MIRROR_ROOT is required for mirror backfill.");
  }

  const checkpoint = options.checkpointPath ? await readCheckpoint(options.checkpointPath) : null;
  const startAfterId = options.startAfterId ?? checkpoint?.lastProcessedId ?? null;
  const allIds = await listMirrorIds(mirrorRoot);
  const firstGreaterIndex = startAfterId ? allIds.findIndex((id) => Number(id) > Number(startAfterId)) : -1;
  const startIndex = startAfterId ? (firstGreaterIndex >= 0 ? firstGreaterIndex : allIds.length) : 0;
  const selectedIds = allIds.slice(startIndex, startIndex + options.limit);
  const results: Array<Record<string, unknown>> = [];
  const errors: Array<Record<string, unknown>> = [];
  let lastProcessedId = startAfterId;

  for (const gutenbergId of selectedIds) {
    try {
      const result = await ingestFromMirror(context, gutenbergId);
      results.push(result);
    } catch (error) {
      errors.push({
        gutenbergId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
    lastProcessedId = gutenbergId;
    if (options.checkpointPath) {
      await writeCheckpoint(options.checkpointPath, {
        lastProcessedId,
        processed: (checkpoint?.processed ?? 0) + results.length + errors.length,
        updatedAt: new Date().toISOString(),
      });
    }
  }

  return {
    mirrorRoot,
    startAfterId,
    processed: results.length + errors.length,
    inserted: results.length,
    errors,
    nextStartAfterId: selectedIds.length > 0 ? selectedIds[selectedIds.length - 1] : startAfterId,
    results,
  };
}

async function backfillMirrorParallel(context: IngestContext, options: MirrorBackfillOptions) {
  const mirrorRoot = process.env.GUTENBERG_MIRROR_ROOT;
  if (!mirrorRoot) {
    throw new Error("GUTENBERG_MIRROR_ROOT is required for mirror backfill.");
  }

  const checkpoint = options.checkpointPath ? await readCheckpoint(options.checkpointPath) : null;
  const startAfterId = options.startAfterId ?? checkpoint?.lastProcessedId ?? null;
  const allIds = await listMirrorIds(mirrorRoot);
  const existingRows = await context.db.query<{ gutenberg_id: string | number }>(
    `
      SELECT CAST(gutenberg_id AS TEXT) AS gutenberg_id
      FROM works
      WHERE gutenberg_id IS NOT NULL
    `,
  );
  const existingIds = new Set(existingRows.rows.map((row) => String(row.gutenberg_id)));
  const firstGreaterIndex = startAfterId ? allIds.findIndex((id) => Number(id) > Number(startAfterId)) : -1;
  const startIndex = startAfterId ? (firstGreaterIndex >= 0 ? firstGreaterIndex : allIds.length) : 0;
  const candidateIds = allIds.slice(startIndex).filter((id) => !existingIds.has(id));
  const concurrency = Math.max(1, Number(options.concurrency ?? process.env.MIRROR_BACKFILL_CONCURRENCY ?? "4"));
  const results: Array<Record<string, unknown>> = [];
  const errors: Array<Record<string, unknown>> = [];
  let cursor = 0;
  let processed = 0;
  let inserted = 0;
  let reservedInsertSlots = 0;
  let skipped = 0;
  let lastProcessedId = startAfterId;

  function claimNextCandidateId() {
    if (inserted + reservedInsertSlots >= options.limit || cursor >= candidateIds.length) {
      return null;
    }
    const gutenbergId = candidateIds[cursor++];
    reservedInsertSlots += 1;
    return gutenbergId;
  }

  async function worker() {
    while (true) {
      const gutenbergId = claimNextCandidateId();
      if (!gutenbergId) {
        break;
      }
      try {
        let result: Awaited<ReturnType<typeof ingestFromMirror>> | null = null;
        let lastError: unknown = null;

        for (let attempt = 0; attempt < 3; attempt += 1) {
          try {
            result = await ingestFromMirror(context, gutenbergId);
            break;
          } catch (error) {
            lastError = error;
            if (attempt < 2) {
              await sleep(1000 * 2 ** attempt);
            }
          }
        }

        if (!result) {
          throw lastError instanceof Error ? lastError : new Error(String(lastError));
        }

        processed += 1;
        lastProcessedId = gutenbergId;
        results.push(result);
        reservedInsertSlots -= 1;
        if ((result as { skipped?: boolean }).skipped) {
          skipped += 1;
        } else {
          inserted += 1;
        }
        if (options.checkpointPath) {
          await writeCheckpoint(options.checkpointPath, {
            lastProcessedId,
            processed,
            updatedAt: new Date().toISOString(),
          });
        }
        if (processed % 25 === 0 || inserted >= options.limit) {
          console.error(
            JSON.stringify({
              phase: "progress",
              processed,
              inserted,
              skipped,
              errors: errors.length,
              lastProcessedId,
            }),
          );
        }
      } catch (error) {
        processed += 1;
        lastProcessedId = gutenbergId;
        reservedInsertSlots -= 1;
        errors.push({
          gutenbergId,
          error: error instanceof Error ? error.message : String(error),
        });
        if (options.checkpointPath) {
          await writeCheckpoint(options.checkpointPath, {
            lastProcessedId,
            processed,
            updatedAt: new Date().toISOString(),
          });
        }
      }
    }
  }

  await Promise.all(Array.from({ length: concurrency }, () => worker()));

  return {
    mirrorRoot,
    startAfterId,
    concurrency,
    candidateCount: candidateIds.length,
    processed,
    inserted,
    skipped,
    errors,
    nextStartAfterId: lastProcessedId,
    results,
  };
}

async function buildContext(): Promise<IngestContext> {
  await loadLocalDevVars(process.cwd());
  const r2Bucket = process.env.R2_BUCKET_NAME;
  const r2Endpoint = process.env.R2_ENDPOINT;
  const r2AccessKeyId = process.env.R2_ACCESS_KEY_ID;
  const r2SecretAccessKey = process.env.R2_SECRET_ACCESS_KEY;

  if (!r2Bucket || !r2Endpoint || !r2AccessKeyId || !r2SecretAccessKey) {
    throw new Error("R2_BUCKET_NAME, R2_ENDPOINT, R2_ACCESS_KEY_ID, and R2_SECRET_ACCESS_KEY are required.");
  }

  return {
    db: createWranglerD1Db({
      cwd: process.cwd(),
      databaseName: process.env.D1_DATABASE_NAME ?? "alphabook-app",
      wranglerConfig: process.env.D1_WRANGLER_CONFIG ?? "apps/orchestrator-worker/wrangler.toml",
    }),
    vectorIndexName: process.env.VECTOR_INDEX_NAME ?? "alphabook-semantic",
    vectorWranglerConfig: process.env.D1_WRANGLER_CONFIG ?? "apps/orchestrator-worker/wrangler.toml",
    r2Bucket,
    r2: new S3Client({
      region: "auto",
      endpoint: r2Endpoint,
      requestHandler: new NodeHttpHandler({
        socketAcquisitionWarningTimeout: 15_000,
        httpsAgent: new HttpsAgent({
          keepAlive: true,
          maxSockets: Number(process.env.R2_MAX_SOCKETS ?? "256"),
        }),
      }),
      credentials: {
        accessKeyId: r2AccessKeyId,
        secretAccessKey: r2SecretAccessKey,
      },
    }),
  };
}

function requireContext(context: IngestContext | null): IngestContext {
  if (!context) {
    throw new Error("D1 access plus R2_BUCKET_NAME, R2_ENDPOINT, R2_ACCESS_KEY_ID, and R2_SECRET_ACCESS_KEY are required.");
  }
  return context;
}

async function main() {
  const [command, ...args] = process.argv.slice(2);
  const requiresContext = ![
    "ingest-fixture",
    "ingest-supreme-court-demo",
    "count-supreme-court",
  ].includes(command ?? "");
  let context: IngestContext | null = null;

  if (requiresContext) {
    context = await buildContext();
  } else {
    try {
      context = await buildContext();
    } catch {
      context = null;
    }
  }

  try {
    if (command === "ingest-url") {
      const [gutenbergId, sourceUrl, ...titleParts] = args;
      if (!gutenbergId || !sourceUrl || titleParts.length === 0) {
        throw new Error("Usage: ingest-url <gutenbergId> <sourceUrl> <title>");
      }
      const result = await ingestUrl(requireContext(context), gutenbergId, sourceUrl, titleParts.join(" "));
      console.log(JSON.stringify(result, null, 2));
      return;
    }

    if (command === "ingest-gutenberg") {
      const [gutenbergId, ...titleParts] = args;
      if (!gutenbergId) {
        throw new Error("Usage: ingest-gutenberg <gutenbergId> [title]");
      }
      const result = await ingestFromMirror(
        requireContext(context),
        gutenbergId,
        titleParts.length ? titleParts.join(" ") : undefined,
      );
      console.log(JSON.stringify(result, null, 2));
      return;
    }

    if (command === "ingest-fixture") {
      const [documentId] = args;
      const resolvedDocumentId = documentId && documentId !== "-" ? documentId : undefined;
      const result = context
        ? await ingestFixtureDocument(context, resolvedDocumentId)
        : await previewFixtureDocument(resolvedDocumentId);
      console.log(JSON.stringify(result, null, 2));
      return;
    }

    if (command === "ingest-supreme-court-demo") {
      const [documentId] = args;
      const resolvedDocumentId = documentId && documentId !== "-" ? documentId : undefined;
      const result = context
        ? await ingestSupremeCourtDemo(context, resolvedDocumentId)
        : await previewSupremeCourtDemo(resolvedDocumentId);
      console.log(JSON.stringify(result, null, 2));
      return;
    }

    if (command === "count-supreme-court") {
      const [startAfterId] = args;
      const result = await countSupremeCourtCases(
        startAfterId && startAfterId !== "-"
          ? Number.parseInt(startAfterId, 10)
          : null,
      );
      console.log(JSON.stringify(result, null, 2));
      return;
    }

    if (command === "ingest-supreme-court-cluster") {
      const [clusterId] = args;
      if (!clusterId) {
        throw new Error("Usage: ingest-supreme-court-cluster <clusterId>");
      }
      const parsedClusterId = Number.parseInt(clusterId, 10);
      if (!Number.isFinite(parsedClusterId)) {
        throw new Error(`Invalid cluster id: ${clusterId}`);
      }
      const result = await ingestSupremeCourtCluster(requireContext(context), parsedClusterId);
      console.log(JSON.stringify(result, null, 2));
      return;
    }

    if (command === "backfill-supreme-court") {
      const [startAfterId, limitValue] = args;
      const parsedStartAfterId = startAfterId && startAfterId !== "-"
        ? Number.parseInt(startAfterId, 10)
        : null;
      const result = await backfillSupremeCourt(requireContext(context), {
        startAfterId: Number.isFinite(parsedStartAfterId ?? NaN) ? parsedStartAfterId : null,
        limit: Number(limitValue ?? process.env.SUPREME_COURT_BATCH_SIZE ?? "25"),
      });
      console.log(JSON.stringify(result, null, 2));
      return;
    }

    if (command === "run-once") {
      const result = await backfillMirror(requireContext(context), {
        limit: Number(process.env.MIRROR_BATCH_SIZE ?? "25"),
        checkpointPath: process.env.MIRROR_CHECKPOINT_PATH ?? ".alphabook/ingest-checkpoint.json",
      });
      console.log(JSON.stringify(result, null, 2));
      return;
    }

    if (command === "backfill-mirror") {
      const [startAfterId, limitValue] = args;
      const result = await backfillMirror(requireContext(context), {
        startAfterId: startAfterId && startAfterId !== "-" ? startAfterId : null,
        limit: Number(limitValue ?? process.env.MIRROR_BATCH_SIZE ?? "100"),
        checkpointPath: process.env.MIRROR_CHECKPOINT_PATH ?? ".alphabook/ingest-checkpoint.json",
      });
      console.log(JSON.stringify(result, null, 2));
      return;
    }

    if (command === "backfill-mirror-parallel") {
      const [startAfterId, limitValue, concurrencyValue] = args;
      const result = await backfillMirrorParallel(requireContext(context), {
        startAfterId: startAfterId && startAfterId !== "-" ? startAfterId : null,
        limit: Number(limitValue ?? process.env.MIRROR_BATCH_SIZE ?? "100"),
        checkpointPath: process.env.MIRROR_CHECKPOINT_PATH ?? ".alphabook/ingest-checkpoint.json",
        concurrency: Number(concurrencyValue ?? process.env.MIRROR_BACKFILL_CONCURRENCY ?? "4"),
      });
      console.log(JSON.stringify(result, null, 2));
      return;
    }

    if (command === "backfill-book-html") {
      const [startAfterId, limitValue, concurrencyValue] = args;
      const result = await backfillBookHtml(requireContext(context), {
        startAfterId: startAfterId && startAfterId !== "-" ? startAfterId : null,
        limit: Number(limitValue ?? process.env.BOOK_HTML_BATCH_SIZE ?? "100"),
        concurrency: Number(concurrencyValue ?? process.env.BOOK_HTML_BACKFILL_CONCURRENCY ?? "8"),
      });
      console.log(JSON.stringify(result, null, 2));
      return;
    }

    if (command === "rebuild-book-html") {
      const [startAfterId, limitValue, concurrencyValue] = args;
      const result = await rebuildBookHtml(requireContext(context), {
        startAfterId: startAfterId && startAfterId !== "-" ? startAfterId : null,
        limit: Number(limitValue ?? process.env.BOOK_HTML_BATCH_SIZE ?? "100"),
        concurrency: Number(concurrencyValue ?? process.env.BOOK_HTML_REBUILD_CONCURRENCY ?? "8"),
      });
      console.log(JSON.stringify(result, null, 2));
      return;
    }

    if (command === "rebuild-book-html-created-at") {
      const [createdAtFrom, createdAtTo, startAfterId, limitValue, concurrencyValue] = args;
      if (!createdAtFrom || !createdAtTo) {
        throw new Error("Usage: rebuild-book-html-created-at <createdAtFrom> <createdAtTo> [startAfterId|-] [limit] [concurrency]");
      }
      const result = await rebuildBookHtmlByCreatedAt(requireContext(context), {
        createdAtFrom,
        createdAtTo,
        startAfterId: startAfterId && startAfterId !== "-" ? startAfterId : null,
        limit: Number(limitValue ?? process.env.BOOK_HTML_BATCH_SIZE ?? "100"),
        concurrency: Number(concurrencyValue ?? process.env.BOOK_HTML_REBUILD_CONCURRENCY ?? "8"),
      });
      console.log(JSON.stringify(result, null, 2));
      return;
    }

    if (command === "delete-gutenberg") {
      if (args.length === 0) {
        throw new Error("Usage: delete-gutenberg <gutenbergId...>");
      }
      const result = await deleteGutenbergWorks(requireContext(context), args);
      console.log(JSON.stringify(result, null, 2));
      return;
    }

    console.log("Commands:");
    console.log("  ingest-url <gutenbergId> <sourceUrl> <title>");
    console.log("  ingest-gutenberg <gutenbergId> [title]");
    console.log("  ingest-fixture [documentId|-]");
    console.log("  ingest-supreme-court-demo [caseId|-]");
    console.log("  count-supreme-court [startAfterClusterId|-]");
    console.log("  ingest-supreme-court-cluster <clusterId>");
    console.log("  backfill-supreme-court [startAfterClusterId|-] [limit]");
    console.log("  backfill-mirror [startAfterId|-] [limit]");
    console.log("  backfill-mirror-parallel [startAfterId|-] [limit] [concurrency]");
    console.log("  backfill-book-html [startAfterId|-] [limit] [concurrency]");
    console.log("  rebuild-book-html [startAfterId|-] [limit] [concurrency]");
    console.log("  rebuild-book-html-created-at <createdAtFrom> <createdAtTo> [startAfterId|-] [limit] [concurrency]");
    console.log("  delete-gutenberg <gutenbergId...>");
    console.log("  run-once");
  } finally {
    await context?.db.end();
    context?.r2.destroy();
  }
}

main()
  .then(() => {
    process.exit(0);
  })
  .catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  });
