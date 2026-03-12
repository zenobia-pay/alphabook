import { DurableObject } from "cloudflare:workers";
import { WorkOS } from "@workos-inc/node";
import { Context, Hono } from "hono";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";

import {
  buildAssistantReply,
  buildDocumentCards,
  buildDocumentContext,
  getDocument,
  getFeedDocuments,
  listDocuments,
  runResearch,
  runSearch,
  type AssistantCitation,
  type DocumentCard,
  type DocumentStats,
  type DocumentView,
  type FeedTab,
  type RailPanel,
  type ResearchMode,
} from "./app/data";
import {
  renderAssistantPage,
  renderAuthPage,
  renderDocumentPage,
  renderHomePage,
  renderImportedBookPage,
  renderLibraryPage,
  renderNotFound,
  renderOnboardingPage,
  renderProfilePage,
  type AssistantThread,
  type CommentRecord,
  type LibraryCollection,
  type NoteRecord,
  type Viewer,
} from "./app/render";

interface Env {
  APP_STATE: DurableObjectNamespace<AppState>;
  AGENT_BACKEND_TOKEN?: string;
  AGENT_BACKEND_URL?: string;
  WORKOS_API_KEY?: string;
  WORKOS_CLIENT_ID?: string;
}

interface StoredUser extends Viewer {
  createdAt: string;
  passwordHash?: string;
  workosUserId?: string;
}

interface SessionRecord {
  token: string;
  userId: string;
  createdAt: string;
  expiresAt: string;
}

interface UserLibrary {
  savedDocIds: string[];
  likedDocIds: string[];
  collections: LibraryCollection[];
  notes: NoteRecord[];
  threads: AssistantThread[];
  recentDocIds: string[];
}

interface StoreDb {
  users: StoredUser[];
  sessions: SessionRecord[];
  libraries: Record<string, UserLibrary>;
  comments: CommentRecord[];
}

interface SnapshotResponse {
  viewer?: Viewer;
  library?: UserLibrary;
  stats: Record<string, DocumentStats>;
}

interface DocumentContextResponse {
  notes: NoteRecord[];
  comments: CommentRecord[];
}

interface ProfileResponse {
  profile?: Viewer;
  stats?: {
    saved: number;
    notes: number;
    comments: number;
    collections: number;
    threads: number;
  };
  collectionNames?: string[];
  recentDocIds?: string[];
}

interface WorkOSAuthStoreResponse {
  viewer: Viewer;
  sessionToken: string;
}

interface AgentJobRecord {
  id: string;
  query: string;
  mode: string;
  book_id?: string;
  status: "queued" | "running" | "completed" | "failed";
  created_at: string;
  updated_at: string;
  result?: {
    synthesis?: string;
    agents?: Array<{
      book?: { id?: string; title?: string };
      summary?: string;
      evidence?: Array<{
        chunk_index?: number;
        excerpt?: string;
      }>;
    }>;
  };
  error?: string;
}

interface BackendBookRecord {
  id: string;
  title: string;
  author: string;
  source_url: string;
  text_length: number;
  chunk_count: number;
  created_at: string;
}

interface BackendBookContext {
  book: BackendBookRecord;
  query?: string | null;
  sections: Array<{
    chunk_index: number;
    content: string;
    excerpt?: string;
    strategy?: string;
    score?: number;
  }>;
}

interface BackendBookSearchResponse {
  query: string;
  mode: string;
  summary: string;
  evidence: Array<{
    chunk_index: number;
    excerpt: string;
    strategy?: string;
    score?: number;
  }>;
}

interface OAuthCookiePayload {
  next: string;
  state: string;
}

type AppVariables = {
  viewer?: Viewer;
  library?: UserLibrary;
  stats: Record<string, DocumentStats>;
  sessionToken?: string;
};

type AppContext = Context<{ Bindings: Env; Variables: AppVariables }>;

const SESSION_COOKIE = "ab_session";
const OAUTH_COOKIE = "ab_oauth";
const SESSION_AGE_SECONDS = 60 * 60 * 24 * 30;
const OAUTH_AGE_SECONDS = 60 * 10;

function defaultLibrary(): UserLibrary {
  const createdAt = new Date().toISOString();
  return {
    savedDocIds: [],
    likedDocIds: [],
    collections: [
      { id: crypto.randomUUID(), name: "Queue", docIds: [], createdAt },
      { id: crypto.randomUUID(), name: "Themes", docIds: [], createdAt },
    ],
    notes: [],
    threads: [],
    recentDocIds: [],
  };
}

function emptyDb(): StoreDb {
  return {
    users: [],
    sessions: [],
    libraries: {},
    comments: [],
  };
}

function normalizeDb(db: Partial<StoreDb> | undefined): StoreDb {
  return {
    users: Array.isArray(db?.users) ? (db.users as StoredUser[]) : [],
    sessions: Array.isArray(db?.sessions) ? (db.sessions as SessionRecord[]) : [],
    libraries: db?.libraries && typeof db.libraries === "object" ? db.libraries : {},
    comments: Array.isArray(db?.comments) ? (db.comments as CommentRecord[]) : [],
  };
}

function publicViewer(user: StoredUser): Viewer {
  return {
    id: user.id,
    name: user.name,
    handle: user.handle,
    email: user.email,
    bio: user.bio,
    interests: user.interests,
    onboardingComplete: user.onboardingComplete,
    avatarUrl: user.avatarUrl,
  };
}

function ensureLibrary(db: StoreDb, userId: string): UserLibrary {
  if (!db.libraries[userId]) {
    db.libraries[userId] = defaultLibrary();
  }
  return db.libraries[userId];
}

function slugify(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);
}

function uniqueHandle(base: string, db: StoreDb): string {
  const root = slugify(base) || "reader";
  let candidate = root;
  let index = 2;
  const existing = new Set(db.users.map((user) => user.handle));
  while (existing.has(candidate)) {
    candidate = `${root}-${index}`;
    index += 1;
  }
  return candidate;
}

function combineStats(db: StoreDb): Record<string, DocumentStats> {
  const stats = Object.fromEntries(
    listDocuments().map((document) => [
      document.id,
      { likes: document.likesSeed, saves: document.savesSeed, comments: document.commentsSeed },
    ]),
  ) as Record<string, DocumentStats>;

  for (const library of Object.values(db.libraries)) {
    for (const documentId of library.savedDocIds) {
      if (stats[documentId]) {
        stats[documentId].saves += 1;
      }
    }
    for (const documentId of library.likedDocIds) {
      if (stats[documentId]) {
        stats[documentId].likes += 1;
      }
    }
  }

  for (const comment of db.comments) {
    if (stats[comment.docId]) {
      stats[comment.docId].comments += 1;
    }
  }

  return stats;
}

function jsonFromRequest(request: Request): Promise<Record<string, unknown>> {
  return request.json() as Promise<Record<string, unknown>>;
}

async function formOrJson(request: Request): Promise<Record<string, string>> {
  const contentType = request.headers.get("content-type") || "";
  if (contentType.includes("application/json")) {
    const body = await request.json();
    return Object.fromEntries(
      Object.entries(body as Record<string, unknown>).map(([key, value]) => [key, String(value ?? "")]),
    );
  }

  const form = await request.formData();
  const entries: Array<[string, string]> = [];
  form.forEach((value, key) => {
    entries.push([key, String(value)]);
  });
  return Object.fromEntries(entries);
}

function authConfigured(env: Env): boolean {
  return Boolean(env.WORKOS_API_KEY && env.WORKOS_CLIENT_ID);
}

function agentBackendConfigured(env: Env): boolean {
  return Boolean(env.AGENT_BACKEND_URL);
}

function sanitizeRedirect(value?: string): string {
  if (!value || !value.startsWith("/") || value.startsWith("//")) {
    return "/";
  }
  return value;
}

function looksLikeGutenbergUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return /(^|\.)gutenberg\.org$/i.test(url.hostname);
  } catch {
    return false;
  }
}

function isSecureRequest(request: Request): boolean {
  return new URL(request.url).protocol === "https:";
}

function cookieOptions(request: Request, maxAge: number) {
  return {
    path: "/",
    maxAge,
    sameSite: "Lax" as const,
    httpOnly: true,
    secure: isSecureRequest(request),
  };
}

function base64UrlEncode(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function base64UrlDecode(value: string): Uint8Array {
  const base64 = value.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(value.length / 4) * 4, "=");
  const binary = atob(base64);
  return Uint8Array.from(binary, (char) => char.charCodeAt(0));
}

function encodeJsonCookie(payload: OAuthCookiePayload): string {
  return base64UrlEncode(new TextEncoder().encode(JSON.stringify(payload)));
}

function decodeJsonCookie(value?: string): OAuthCookiePayload | undefined {
  if (!value) {
    return undefined;
  }
  try {
    return JSON.parse(new TextDecoder().decode(base64UrlDecode(value))) as OAuthCookiePayload;
  } catch {
    return undefined;
  }
}

function sessionFromToken(db: StoreDb, token?: string): SessionRecord | undefined {
  if (!token) {
    return undefined;
  }
  return db.sessions.find((record) => record.token === token && new Date(record.expiresAt) > new Date());
}

function getWorkOS(env: Env): WorkOS {
  if (!authConfigured(env)) {
    throw new Error("WorkOS is not configured.");
  }
  return new WorkOS({
    apiKey: env.WORKOS_API_KEY,
    clientId: env.WORKOS_CLIENT_ID,
  });
}

function getRedirectUri(request: Request): string {
  return `${new URL(request.url).origin}/auth/google/callback`;
}

function getAuthorizationUrl(request: Request, env: Env, payload: OAuthCookiePayload): string {
  return getWorkOS(env).userManagement.getAuthorizationUrl({
    provider: "GoogleOAuth",
    clientId: env.WORKOS_CLIENT_ID,
    redirectUri: getRedirectUri(request),
    state: payload.state,
  });
}

function displayName(email: string, firstName: string | null, lastName: string | null): string {
  const name = [firstName, lastName].filter(Boolean).join(" ").trim();
  return name || email.split("@")[0] || "Reader";
}

function agentBackendHeaders(env: Env, initHeaders?: HeadersInit): Headers {
  const headers = new Headers(initHeaders);
  if (env.AGENT_BACKEND_TOKEN) {
    headers.set("authorization", `Bearer ${env.AGENT_BACKEND_TOKEN}`);
  }
  return headers;
}

async function agentBackendRequest<T>(
  env: Env,
  path: string,
  init?: RequestInit & { json?: unknown },
): Promise<T> {
  if (!env.AGENT_BACKEND_URL) {
    throw new Error("Agent backend is not configured.");
  }

  const requestInit: RequestInit = {
    method: init?.method ?? "GET",
    headers: agentBackendHeaders(env, init?.headers),
    body: init?.body,
  };
  if (init?.json !== undefined) {
    requestInit.body = JSON.stringify(init.json);
    requestInit.headers = agentBackendHeaders(env, {
      "content-type": "application/json",
      ...(init.headers || {}),
    });
  }

  const base = env.AGENT_BACKEND_URL.endsWith("/") ? env.AGENT_BACKEND_URL.slice(0, -1) : env.AGENT_BACKEND_URL;
  const response = await fetch(`${base}${path}`, requestInit);
  if (!response.ok) {
    const message = await response.text();
    throw new Error(message || `Agent backend request failed for ${path}`);
  }
  return (await response.json()) as T;
}

function buildAgentCitations(job: AgentJobRecord): AssistantCitation[] {
  return (job.result?.agents ?? []).flatMap((agent) => {
    const bookId = agent.book?.id;
    const isImported = bookId?.startsWith("gutenberg-");
    const baseHref = isImported
      ? `/book/${bookId}?q=${encodeURIComponent(job.query)}`
      : `/doc/${bookId ?? "don-quixote"}?panel=assistant`;
    return (agent.evidence ?? []).slice(0, 4).map((evidence, index) => ({
      label: `${agent.book?.title ?? "Document"} · passage ${index + 1}`,
      href: isImported
        ? `${baseHref}#evidence-${evidence.chunk_index ?? index + 1}`
        : `${baseHref}#chunk-${evidence.chunk_index ?? index + 1}`,
      excerpt: evidence.excerpt ?? agent.summary ?? "",
    }));
  });
}

function buildAgentSummary(job: AgentJobRecord): string {
  if (job.status === "failed") {
    return `Agent run failed. ${job.error ?? ""}`.trim();
  }
  return job.result?.synthesis || "Agent run completed.";
}

function isImportedBookDocId(docId?: string): boolean {
  return Boolean(docId && docId.startsWith("book:"));
}

function importedBookIdFromDocId(docId?: string): string | undefined {
  if (!isImportedBookDocId(docId)) {
    return undefined;
  }
  return docId?.slice("book:".length);
}

function assistantRedirect(base: string | undefined, threadId: string): string {
  if (!base) {
    return `/assistant?threadId=${threadId}`;
  }
  if (base.includes("/assistant")) {
    return `${base}${base.includes("?") ? "&" : "?"}threadId=${threadId}`;
  }
  return base;
}

async function bookSearchReply(env: Env, importedBookId: string, prompt: string): Promise<{
  answer: string;
  citations: AssistantCitation[];
}> {
  if (!agentBackendConfigured(env)) {
    return {
      answer: "The book backend is not configured yet.",
      citations: [],
    };
  }
  const result = await agentBackendRequest<{
    summary: string;
    evidence: Array<{ chunk_index: number; excerpt: string }>;
  }>(env, `/books/${encodeURIComponent(importedBookId)}/search?q=${encodeURIComponent(prompt)}`);
  return {
    answer: result.summary,
    citations: result.evidence.slice(0, 4).map((evidence, index) => ({
      label: `Passage ${index + 1}`,
      href: `/book/${importedBookId}?q=${encodeURIComponent(prompt)}#evidence-${evidence.chunk_index}`,
      excerpt: evidence.excerpt,
    })),
  };
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function looksLikeHtmlDocument(contentType: string | null, body: string): boolean {
  return Boolean(
    contentType?.includes("text/html") ||
      /^\s*<!doctype html/i.test(body) ||
      /<html[\s>]/i.test(body) ||
      /<body[\s>]/i.test(body),
  );
}

function sourceBaseHref(sourceUrl: string): string {
  const base = new URL(sourceUrl);
  const lastSlash = base.pathname.lastIndexOf("/");
  base.pathname = lastSlash >= 0 ? base.pathname.slice(0, lastSlash + 1) : "/";
  base.search = "";
  base.hash = "";
  return base.toString();
}

function injectReaderBase(html: string, sourceUrl: string): string {
  const baseTag = `<base href="${escapeHtml(sourceBaseHref(sourceUrl))}">`;
  const cleaned = html.replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, "");
  if (/<base\b/i.test(cleaned)) {
    return cleaned;
  }
  if (/<head[^>]*>/i.test(cleaned)) {
    return cleaned.replace(/<head([^>]*)>/i, `<head$1>${baseTag}`);
  }
  return `<!doctype html><html><head><meta charset="utf-8">${baseTag}</head><body>${cleaned}</body></html>`;
}

function wrapPlainTextBook(title: string, author: string, text: string, sourceUrl: string): string {
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>${escapeHtml(title)}</title>
    <style>
      :root { color-scheme: light; }
      body {
        margin: 0;
        padding: 48px 24px 80px;
        background: #f8f4eb;
        color: #181512;
        font-family: "Iowan Old Style", "Palatino Linotype", serif;
        line-height: 1.65;
      }
      main {
        max-width: 760px;
        margin: 0 auto;
      }
      h1 { margin: 0 0 8px; font-size: 2.6rem; line-height: 0.95; }
      .meta { margin: 0 0 28px; color: #6a655d; }
      .source { margin-bottom: 28px; }
      pre {
        white-space: pre-wrap;
        word-break: break-word;
        font: inherit;
        margin: 0;
      }
      a { color: inherit; }
    </style>
  </head>
  <body>
    <main>
      <h1>${escapeHtml(title)}</h1>
      <div class="meta">${escapeHtml(author)}</div>
      <div class="source"><a href="${escapeHtml(sourceUrl)}" target="_top" rel="noreferrer">Open source</a></div>
      <pre>${escapeHtml(text)}</pre>
    </main>
  </body>
</html>`;
}

export class AppState extends DurableObject<Env> {
  constructor(state: DurableObjectState, env: Env) {
    super(state, env);
  }

  private async loadDb(): Promise<StoreDb> {
    const stored = await this.ctx.storage.get<StoreDb>("db");
    return normalizeDb(stored ?? emptyDb());
  }

  private async saveDb(db: StoreDb): Promise<void> {
    await this.ctx.storage.put("db", db);
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const db = await this.loadDb();

    if (url.pathname === "/snapshot" && request.method === "GET") {
      const session = sessionFromToken(db, url.searchParams.get("sessionToken") || undefined);
      const stats = combineStats(db);
      if (!session) {
        return Response.json({ stats } satisfies SnapshotResponse);
      }
      const user = db.users.find((candidate) => candidate.id === session.userId);
      if (!user) {
        return Response.json({ stats } satisfies SnapshotResponse);
      }
      return Response.json({
        viewer: publicViewer(user),
        library: ensureLibrary(db, user.id),
        stats,
      } satisfies SnapshotResponse);
    }

    if (url.pathname === "/workos-auth" && request.method === "POST") {
      const body = await jsonFromRequest(request);
      const workosUserId = String(body.workosUserId || "");
      const email = String(body.email || "").trim().toLowerCase();
      const name = String(body.name || "").trim() || email.split("@")[0] || "Reader";
      const avatarUrl = String(body.avatarUrl || "").trim() || undefined;
      if (!workosUserId || !email) {
        return Response.json({ error: "Missing WorkOS identity fields." }, { status: 400 });
      }

      let user = db.users.find((candidate) => candidate.workosUserId === workosUserId);
      if (!user) {
        user = db.users.find((candidate) => candidate.email === email);
      }

      if (!user) {
        user = {
          id: crypto.randomUUID(),
          workosUserId,
          name,
          handle: uniqueHandle(name, db),
          email,
          bio: "Researching long-form texts.",
          interests: [],
          onboardingComplete: false,
          avatarUrl,
          createdAt: new Date().toISOString(),
        };
        db.users.push(user);
      } else {
        user.workosUserId = workosUserId;
        user.email = email;
        user.name = name || user.name;
        user.avatarUrl = avatarUrl ?? user.avatarUrl;
      }

      const session: SessionRecord = {
        token: crypto.randomUUID(),
        userId: user.id,
        createdAt: new Date().toISOString(),
        expiresAt: new Date(Date.now() + SESSION_AGE_SECONDS * 1000).toISOString(),
      };

      db.sessions.push(session);
      ensureLibrary(db, user.id);
      await this.saveDb(db);
      return Response.json({
        viewer: publicViewer(user),
        sessionToken: session.token,
      } satisfies WorkOSAuthStoreResponse);
    }

    if (url.pathname === "/signout" && request.method === "POST") {
      const body = await jsonFromRequest(request);
      const token = String(body.sessionToken || "");
      db.sessions = db.sessions.filter((record) => record.token !== token);
      await this.saveDb(db);
      return Response.json({ ok: true });
    }

    if (url.pathname === "/onboarding" && request.method === "POST") {
      const body = await jsonFromRequest(request);
      const userId = String(body.userId || "");
      const bio = String(body.bio || "").trim();
      const interests = String(body.interests || "")
        .split(",")
        .map((interest) => interest.trim().toLowerCase())
        .filter(Boolean);
      const user = db.users.find((candidate) => candidate.id === userId);
      if (!user) {
        return Response.json({ error: "User not found." }, { status: 404 });
      }
      user.bio = bio || user.bio;
      user.interests = interests;
      user.onboardingComplete = true;
      await this.saveDb(db);
      return Response.json({ viewer: publicViewer(user) });
    }

    if (url.pathname === "/profile" && request.method === "POST") {
      const body = await jsonFromRequest(request);
      const userId = String(body.userId || "");
      const bio = String(body.bio || "").trim();
      const interests = String(body.interests || "")
        .split(",")
        .map((interest) => interest.trim().toLowerCase())
        .filter(Boolean);
      const user = db.users.find((candidate) => candidate.id === userId);
      if (!user) {
        return Response.json({ error: "User not found." }, { status: 404 });
      }
      if (bio) {
        user.bio = bio;
      }
      user.interests = interests;
      await this.saveDb(db);
      return Response.json({ viewer: publicViewer(user) });
    }

    if (url.pathname === "/toggle-save" && request.method === "POST") {
      const body = await jsonFromRequest(request);
      const userId = String(body.userId || "");
      const docId = String(body.docId || "");
      const library = ensureLibrary(db, userId);
      if (library.savedDocIds.includes(docId)) {
        library.savedDocIds = library.savedDocIds.filter((id) => id !== docId);
      } else {
        library.savedDocIds.unshift(docId);
        if (library.collections[0] && !library.collections[0].docIds.includes(docId)) {
          library.collections[0].docIds.unshift(docId);
        }
      }
      await this.saveDb(db);
      return Response.json({ library, stats: combineStats(db) });
    }

    if (url.pathname === "/toggle-like" && request.method === "POST") {
      const body = await jsonFromRequest(request);
      const userId = String(body.userId || "");
      const docId = String(body.docId || "");
      const library = ensureLibrary(db, userId);
      if (library.likedDocIds.includes(docId)) {
        library.likedDocIds = library.likedDocIds.filter((id) => id !== docId);
      } else {
        library.likedDocIds.unshift(docId);
      }
      await this.saveDb(db);
      return Response.json({ library, stats: combineStats(db) });
    }

    if (url.pathname === "/create-collection" && request.method === "POST") {
      const body = await jsonFromRequest(request);
      const userId = String(body.userId || "");
      const name = String(body.name || "").trim();
      if (!name) {
        return Response.json({ error: "Collection name required." }, { status: 400 });
      }
      const library = ensureLibrary(db, userId);
      library.collections.unshift({
        id: crypto.randomUUID(),
        name,
        docIds: [],
        createdAt: new Date().toISOString(),
      });
      await this.saveDb(db);
      return Response.json({ library });
    }

    if (url.pathname === "/document-context" && request.method === "GET") {
      const docId = url.searchParams.get("docId") || "";
      const userId = url.searchParams.get("userId") || "";
      const notes = userId ? ensureLibrary(db, userId).notes.filter((note) => note.docId === docId) : [];
      const comments = db.comments.filter((comment) => comment.docId === docId).slice(-20).reverse();
      return Response.json({ notes, comments } satisfies DocumentContextResponse);
    }

    if (url.pathname === "/note" && request.method === "POST") {
      const body = await jsonFromRequest(request);
      const userId = String(body.userId || "");
      const docId = String(body.docId || "");
      const anchor = String(body.anchor || "").trim() || "Untitled note";
      const text = String(body.text || "").trim();
      if (!text) {
        return Response.json({ error: "Note text required." }, { status: 400 });
      }
      const library = ensureLibrary(db, userId);
      library.notes.unshift({
        id: crypto.randomUUID(),
        docId,
        anchor,
        text,
        createdAt: new Date().toISOString(),
      });
      await this.saveDb(db);
      return Response.json({ notes: library.notes.filter((note) => note.docId === docId) });
    }

    if (url.pathname === "/comment" && request.method === "POST") {
      const body = await jsonFromRequest(request);
      const userId = String(body.userId || "");
      const docId = String(body.docId || "");
      const text = String(body.text || "").trim();
      const user = db.users.find((candidate) => candidate.id === userId);
      if (!user || !text) {
        return Response.json({ error: "Comment text required." }, { status: 400 });
      }
      db.comments.unshift({
        id: crypto.randomUUID(),
        docId,
        userId: user.id,
        userName: user.name,
        handle: user.handle,
        text,
        createdAt: new Date().toISOString(),
      });
      await this.saveDb(db);
      return Response.json({ comments: db.comments.filter((comment) => comment.docId === docId).slice(0, 20) });
    }

    if (url.pathname === "/assistant" && request.method === "GET") {
      const userId = url.searchParams.get("userId") || "";
      const library = ensureLibrary(db, userId);
      return Response.json({ threads: library.threads });
    }

    if (url.pathname === "/assistant-save" && request.method === "POST") {
      const body = await jsonFromRequest(request);
      const userId = String(body.userId || "");
      const docId = String(body.docId || "") || undefined;
      const prompt = String(body.prompt || "");
      const answer = String(body.answer || "");
      const citations = (body.citations as AssistantCitation[]) || [];
      const mode: "fast" | "agent" = body.mode === "agent" ? "agent" : "fast";
      const status: "pending" | "completed" | "failed" =
        body.status === "pending" || body.status === "failed" ? body.status : "completed";
      const jobId = String(body.jobId || "") || undefined;
      const threadId = String(body.threadId || "") || crypto.randomUUID();
      const library = ensureLibrary(db, userId);
      const now = new Date().toISOString();
      const title = prompt.split(/\s+/).slice(0, 8).join(" ");
      let thread = library.threads.find((candidate) => candidate.id === threadId);
      if (!thread) {
        thread = {
          id: threadId,
          title: title || "Untitled thread",
          docId,
          createdAt: now,
          updatedAt: now,
          messages: [],
        };
        library.threads.unshift(thread);
      }
      thread.title = thread.title || title || "Untitled thread";
      thread.updatedAt = now;
      thread.docId = docId;
      thread.messages.push(
        { role: "user", content: prompt, createdAt: now },
        { role: "assistant", content: answer, citations, createdAt: now, mode, status, jobId },
      );
      await this.saveDb(db);
      return Response.json({ thread });
    }

    if (url.pathname === "/assistant-update" && request.method === "POST") {
      const body = await jsonFromRequest(request);
      const userId = String(body.userId || "");
      const threadId = String(body.threadId || "");
      const jobId = String(body.jobId || "");
      const answer = String(body.answer || "");
      const citations = (body.citations as AssistantCitation[]) || [];
      const status: "pending" | "completed" | "failed" =
        body.status === "pending" || body.status === "failed" ? body.status : "completed";
      const library = ensureLibrary(db, userId);
      const now = new Date().toISOString();
      const thread = library.threads.find((candidate) => candidate.id === threadId);
      if (!thread) {
        return Response.json({ error: "Thread not found." }, { status: 404 });
      }

      const pendingMessage = thread.messages.find(
        (message) => message.role === "assistant" && message.jobId === jobId,
      );
      if (pendingMessage) {
        pendingMessage.content = answer;
        pendingMessage.citations = citations;
        pendingMessage.status = status;
        pendingMessage.mode = "agent";
      } else {
        thread.messages.push({
          role: "assistant",
          content: answer,
          citations,
          createdAt: now,
          jobId,
          status,
          mode: "agent",
        });
      }
      thread.updatedAt = now;
      await this.saveDb(db);
      return Response.json({ thread });
    }

    if (url.pathname === "/touch" && request.method === "POST") {
      const body = await jsonFromRequest(request);
      const userId = String(body.userId || "");
      const docId = String(body.docId || "");
      const library = ensureLibrary(db, userId);
      library.recentDocIds = [docId, ...library.recentDocIds.filter((id) => id !== docId)].slice(0, 8);
      await this.saveDb(db);
      return Response.json({ ok: true });
    }

    if (url.pathname === "/profile" && request.method === "GET") {
      const handle = url.searchParams.get("handle") || "";
      const user = db.users.find((candidate) => candidate.handle === handle);
      if (!user) {
        return Response.json({ profile: undefined } satisfies ProfileResponse, { status: 404 });
      }
      const library = ensureLibrary(db, user.id);
      const commentCount = db.comments.filter((comment) => comment.userId === user.id).length;
      return Response.json({
        profile: publicViewer(user),
        stats: {
          saved: library.savedDocIds.length,
          notes: library.notes.length,
          comments: commentCount,
          collections: library.collections.length,
          threads: library.threads.length,
        },
        collectionNames: library.collections.map((collection) => collection.name),
        recentDocIds: library.recentDocIds,
      } satisfies ProfileResponse);
    }

    return Response.json({ error: "Not found" }, { status: 404 });
  }
}

const app = new Hono<{ Bindings: Env; Variables: AppVariables }>();

function getStore(env: Env) {
  return env.APP_STATE.get(env.APP_STATE.idFromName("global"));
}

async function storeRequest<T>(
  env: Env,
  path: string,
  init?: RequestInit & { json?: unknown },
  allowError = false,
): Promise<T> {
  const requestInit: RequestInit = {
    method: init?.method ?? "GET",
    headers: init?.headers,
    body: init?.body,
  };
  if (init?.json !== undefined) {
    requestInit.body = JSON.stringify(init.json);
    requestInit.headers = {
      "content-type": "application/json",
      ...(init.headers || {}),
    };
  }
  const response = await getStore(env).fetch(`https://app.internal${path}`, requestInit);
  if (!allowError && !response.ok) {
    const payload = (await response.json()) as { error?: string };
    throw new Error(payload.error || `Store request failed for ${path}`);
  }
  return (await response.json()) as T;
}

app.use("*", async (c, next) => {
  const sessionToken = getCookie(c, SESSION_COOKIE);
  const snapshot = await storeRequest<SnapshotResponse>(
    c.env,
    `/snapshot${sessionToken ? `?sessionToken=${encodeURIComponent(sessionToken)}` : ""}`,
  );
  c.set("viewer", snapshot.viewer);
  c.set("library", snapshot.library);
  c.set("stats", snapshot.stats);
  c.set("sessionToken", sessionToken);
  await next();
});

function viewerState(c: AppContext) {
  const viewer = c.get("viewer") as Viewer | undefined;
  const library = c.get("library") as UserLibrary | undefined;
  return { viewer, library, stats: c.get("stats") as Record<string, DocumentStats> };
}

function currentUrl(c: AppContext): string {
  const url = new URL(c.req.url);
  return url.pathname + url.search;
}

function redirectToSignIn(c: AppContext, next = currentUrl(c)) {
  return c.redirect(`/signin?next=${encodeURIComponent(sanitizeRedirect(next))}`);
}

function documentCardsForViewer(c: AppContext): DocumentCard[] {
  const { viewer, library, stats } = viewerState(c);
  return buildDocumentCards(stats, {
    likedDocIds: library?.likedDocIds ?? [],
    savedDocIds: library?.savedDocIds ?? [],
    interests: viewer?.interests ?? [],
  });
}

function documentCardIndex(cards: DocumentCard[]): Record<string, DocumentCard> {
  return Object.fromEntries(cards.map((card) => [card.id, card]));
}

function pendingAgentMessages(thread?: AssistantThread) {
  return (
    thread?.messages.filter(
      (message) => message.role === "assistant" && message.mode === "agent" && message.status === "pending" && message.jobId,
    ) ?? []
  );
}

async function syncPendingAgentThread(
  env: Env,
  viewer: Viewer | undefined,
  thread: AssistantThread | undefined,
): Promise<{ thread: AssistantThread | undefined; updated: boolean }> {
  if (!viewer || !thread || !agentBackendConfigured(env)) {
    return { thread, updated: false };
  }

  let updated = false;
  let nextThread = thread;
  for (const message of pendingAgentMessages(thread)) {
    try {
      const job = await agentBackendRequest<AgentJobRecord>(env, `/jobs/${encodeURIComponent(message.jobId ?? "")}`);
      if (job.status === "completed" || job.status === "failed") {
        const payload = await storeRequest<{ thread: AssistantThread }>(env, "/assistant-update", {
          method: "POST",
          json: {
            userId: viewer.id,
            threadId: thread.id,
            jobId: message.jobId,
            answer: buildAgentSummary(job),
            citations: buildAgentCitations(job),
            status: job.status,
          },
        });
        nextThread = payload.thread;
        updated = true;
      }
    } catch {
      continue;
    }
  }

  return { thread: nextThread, updated };
}

app.get("/", async (c) => {
  const requestedTab = c.req.query("tab");
  const tab: FeedTab = requestedTab === "likes" || requestedTab === "briefs" ? requestedTab : "hot";
  const q = c.req.query("q");
  const cards = getFeedDocuments(tab, c.get("stats"), {
    likedDocIds: c.get("library")?.likedDocIds ?? [],
    savedDocIds: c.get("library")?.savedDocIds ?? [],
    interests: c.get("viewer")?.interests ?? [],
  });
  let importedBooks: Array<{
    id: string;
    title: string;
    author: string;
    chunkCount: number;
    sourceUrl: string;
  }> = [];
  if (agentBackendConfigured(c.env)) {
    try {
      const payload = await agentBackendRequest<{ books: BackendBookRecord[] }>(c.env, "/books");
      importedBooks = payload.books
        .filter((book) => book.id !== "don-quixote")
        .map((book) => ({
          id: book.id,
          title: book.title,
          author: book.author,
          chunkCount: book.chunk_count,
          sourceUrl: book.source_url,
          createdAt: book.created_at,
        }))
        .sort((left, right) => right.createdAt.localeCompare(left.createdAt))
        .map(({ createdAt: _createdAt, ...book }) => book);
    } catch {
      importedBooks = [];
    }
  }
  return c.html(
    renderHomePage({
      viewer: c.get("viewer"),
      activeTab: tab,
      documents: cards,
      search: q ? runSearch(q) : undefined,
      importError: c.req.query("importError") ?? undefined,
      importedBooks,
    }),
  );
});

app.get("/search", async (c) => {
  const q = c.req.query("q")?.trim();
  return c.redirect(q ? `/assistant?prompt=${encodeURIComponent(q)}` : "/");
});

app.get("/doc/:id", async (c) => {
  const docId = c.req.param("id");
  const requestedPanel = c.req.query("panel");
  const panel: RailPanel =
    requestedPanel === "notes" || requestedPanel === "comments" || requestedPanel === "similar"
      ? requestedPanel
      : "assistant";
  const requestedView = c.req.query("view");
  const view: DocumentView =
    requestedView === "brief" || requestedView === "resources" ? requestedView : "document";
  const q = c.req.query("q");
  const cards = documentCardsForViewer(c);
  const cardById = documentCardIndex(cards);
  const document = cardById[docId];
  if (!document) {
    return c.html(renderNotFound(c.get("viewer")), 404);
  }

  const context = buildDocumentContext(docId, q);
  if (!context) {
    return c.html(renderNotFound(c.get("viewer")), 404);
  }

  const viewer = c.get("viewer") as Viewer | undefined;
  if (viewer) {
    await storeRequest(c.env, "/touch", {
      method: "POST",
      json: { userId: viewer.id, docId },
    });
  }

  const docContext = await storeRequest<DocumentContextResponse>(
    c.env,
    `/document-context?docId=${encodeURIComponent(docId)}${viewer ? `&userId=${encodeURIComponent(viewer.id)}` : ""}`,
  );
  const threadResponse = viewer
    ? await storeRequest<{ threads: AssistantThread[] }>(c.env, `/assistant?userId=${encodeURIComponent(viewer.id)}`)
    : { threads: [] };
  let thread = threadResponse.threads.find((candidate) => candidate.docId === docId);
  const sync = await syncPendingAgentThread(c.env, viewer, thread);
  if (sync.updated && viewer) {
    const refreshed = await storeRequest<{ threads: AssistantThread[] }>(c.env, `/assistant?userId=${encodeURIComponent(viewer.id)}`);
    thread = refreshed.threads.find((candidate) => candidate.docId === docId);
  } else {
    thread = sync.thread;
  }

  return c.html(
    renderDocumentPage({
      viewer,
      document,
      view,
      panel,
      sections: context.sections,
      related: [],
      search: q ? runSearch(q) : undefined,
      notes: docContext.notes,
      comments: docContext.comments,
      thread,
      agentEnabled: agentBackendConfigured(c.env),
    }),
  );
});

app.get("/book/:id", async (c) => {
  if (!agentBackendConfigured(c.env)) {
    return c.redirect("/?importError=Book%20backend%20is%20not%20configured.");
  }

  const bookId = c.req.param("id");
  const query = c.req.query("q")?.trim();
  const viewer = c.get("viewer") as Viewer | undefined;
  let context: BackendBookContext;
  let fastAnswer: BackendBookSearchResponse | undefined;
  try {
    [context, fastAnswer] = await Promise.all([
      agentBackendRequest<BackendBookContext>(
        c.env,
        `/books/${encodeURIComponent(bookId)}/context${query ? `?q=${encodeURIComponent(query)}` : ""}`,
      ),
      query
        ? agentBackendRequest<BackendBookSearchResponse>(
            c.env,
            `/books/${encodeURIComponent(bookId)}/search?q=${encodeURIComponent(query)}`,
          )
        : Promise.resolve(undefined),
    ]);
  } catch {
    return c.html(renderNotFound(viewer), 404);
  }

  let thread: AssistantThread | undefined;
  if (viewer) {
    const threadsResponse = await storeRequest<{ threads: AssistantThread[] }>(
      c.env,
      `/assistant?userId=${encodeURIComponent(viewer.id)}`,
    );
    thread = threadsResponse.threads.find((candidate) => candidate.docId === `book:${bookId}`);
    const sync = await syncPendingAgentThread(c.env, viewer, thread);
    if (sync.updated) {
      const refreshed = await storeRequest<{ threads: AssistantThread[] }>(
        c.env,
        `/assistant?userId=${encodeURIComponent(viewer.id)}`,
      );
      thread = refreshed.threads.find((candidate) => candidate.docId === `book:${bookId}`);
    } else {
      thread = sync.thread;
    }
  }

  return c.html(
    renderImportedBookPage({
      viewer,
      book: context.book,
      sections: context.sections,
      query: query || undefined,
      thread,
      agentEnabled: agentBackendConfigured(c.env),
      readUrl: `/book/${bookId}/read`,
      fastAnswer,
    }),
  );
});

app.get("/book/:id/read", async (c) => {
  if (!agentBackendConfigured(c.env)) {
    return c.text("Book backend is not configured.", 503);
  }

  const bookId = c.req.param("id");
  let book: BackendBookRecord;
  try {
    book = await agentBackendRequest<BackendBookRecord>(c.env, `/books/${encodeURIComponent(bookId)}`);
  } catch {
    return c.text("Book not found.", 404);
  }

  const sourceResponse = await fetch(book.source_url);
  if (!sourceResponse.ok) {
    return c.text("Could not load source document.", 502);
  }

  const contentType = sourceResponse.headers.get("content-type");
  const body = await sourceResponse.text();
  if (looksLikeHtmlDocument(contentType, body)) {
    return new Response(injectReaderBase(body, book.source_url), {
      headers: {
        "content-type": "text/html; charset=utf-8",
        "cache-control": "public, max-age=3600",
      },
    });
  }

  return new Response(wrapPlainTextBook(book.title, book.author, body, book.source_url), {
    headers: {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "public, max-age=3600",
    },
  });
});

app.get("/assistant", async (c) => {
  const viewer = c.get("viewer") as Viewer | undefined;
  if (!viewer) {
    return redirectToSignIn(c);
  }

  const cards = documentCardsForViewer(c);
  const threadsResponse = await storeRequest<{ threads: AssistantThread[] }>(
    c.env,
    `/assistant?userId=${encodeURIComponent(viewer.id)}`,
  );
  const threadId = c.req.query("threadId");
  let activeThread = threadId
    ? threadsResponse.threads.find((thread) => thread.id === threadId)
    : threadsResponse.threads[0];
  const sync = await syncPendingAgentThread(c.env, viewer, activeThread);
  let threads = threadsResponse.threads;
  if (sync.updated) {
    const refreshed = await storeRequest<{ threads: AssistantThread[] }>(c.env, `/assistant?userId=${encodeURIComponent(viewer.id)}`);
    threads = refreshed.threads;
    activeThread = threadId ? threads.find((thread) => thread.id === threadId) : threads[0];
  } else {
    activeThread = sync.thread;
  }
  return c.html(
    renderAssistantPage({
      viewer,
      availableDocs: cards,
      threads,
      activeThread,
      activeDocId: c.req.query("docId") ?? activeThread?.docId ?? undefined,
      prompt: c.req.query("prompt") ?? undefined,
      agentEnabled: agentBackendConfigured(c.env),
    }),
  );
});

app.get("/library", async (c) => {
  const viewer = c.get("viewer") as Viewer | undefined;
  const library = c.get("library") as UserLibrary | undefined;
  if (!viewer || !library) {
    return redirectToSignIn(c);
  }

  const cards = documentCardIndex(documentCardsForViewer(c));
  const savedDocuments = library.savedDocIds.map((id) => cards[id]).filter(Boolean);
  const recentDocuments = library.recentDocIds.map((id) => cards[id]).filter(Boolean);
  const collections = library.collections.map((collection) => ({
    ...collection,
    docs: collection.docIds.map((id) => cards[id]).filter(Boolean),
  }));

  return c.html(
    renderLibraryPage({
      viewer,
      savedDocuments,
      recentDocuments,
      collections,
      notesCount: library.notes.length,
      threadsCount: library.threads.length,
    }),
  );
});

app.get("/u/:handle", async (c) => {
  const profileResponse = await storeRequest<ProfileResponse>(
    c.env,
    `/profile?handle=${encodeURIComponent(c.req.param("handle"))}`,
    undefined,
    true,
  );
  if (!profileResponse.profile || !profileResponse.stats || !profileResponse.collectionNames) {
    return c.html(renderNotFound(c.get("viewer")), 404);
  }
  const viewer = c.get("viewer") as Viewer | undefined;
  const cards = documentCardIndex(documentCardsForViewer(c));
  const historyItems = (
    await Promise.all(
      (profileResponse.recentDocIds ?? []).slice(0, 8).map(async (docId) => {
        if (docId.startsWith("book:")) {
          const bookId = importedBookIdFromDocId(docId);
          if (!bookId) {
            return undefined;
          }
          if (agentBackendConfigured(c.env)) {
            try {
              const book = await agentBackendRequest<BackendBookRecord>(c.env, `/books/${encodeURIComponent(bookId)}`);
              return {
                title: book.title,
                href: `/book/${book.id}`,
                summary: `${book.author} · ${book.chunk_count} searchable chunks`,
                meta: "Recently opened book",
                previewLabel: "Book",
              };
            } catch {
              return {
                title: bookId,
                href: `/book/${bookId}`,
                summary: "Imported Gutenberg reader",
                meta: "Recently opened book",
                previewLabel: "Book",
              };
            }
          }
          return {
            title: bookId,
            href: `/book/${bookId}`,
            summary: "Imported Gutenberg reader",
            meta: "Recently opened book",
            previewLabel: "Book",
          };
        }

        const card = cards[docId];
        if (!card) {
          return undefined;
        }
        return {
          title: card.title,
          href: `/doc/${card.id}`,
          summary: card.summary,
          meta: `${card.year} · ${card.venue}`,
          previewLabel: card.kind,
        };
      }),
    )
  ).filter(Boolean) as Array<{
    title: string;
    href: string;
    summary: string;
    meta: string;
    previewLabel: string;
  }>;
  return c.html(
    renderProfilePage({
      viewer,
      profile: profileResponse.profile,
      ownProfile: viewer?.id === profileResponse.profile.id,
      stats: profileResponse.stats,
      collectionNames: profileResponse.collectionNames,
      historyItems,
    }),
  );
});

app.get("/labs", async (c) => {
  return c.redirect("/assistant");
});

app.get("/signin", async (c) => {
  if (c.get("viewer")) {
    return c.redirect("/");
  }
  if (authConfigured(c.env) && !c.req.query("error")) {
    return c.redirect(`/auth/google/start${c.req.query("next") ? `?next=${encodeURIComponent(sanitizeRedirect(c.req.query("next") ?? undefined))}` : ""}`);
  }
  return c.html(
    renderAuthPage({
      mode: "signin",
      error: c.req.query("error") ?? undefined,
      authConfigured: authConfigured(c.env),
      next: sanitizeRedirect(c.req.query("next") ?? undefined),
      origin: new URL(c.req.url).origin,
    }),
  );
});

app.get("/signup", async (c) => c.redirect("/signin"));

app.get("/onboarding", async (c) => {
  const viewer = c.get("viewer") as Viewer | undefined;
  if (!viewer) {
    return redirectToSignIn(c);
  }
  return c.html(renderOnboardingPage({ viewer }));
});

app.get("/auth/google/start", async (c) => {
  if (!authConfigured(c.env)) {
    return c.redirect("/signin?error=WorkOS%20is%20not%20configured.");
  }
  const payload: OAuthCookiePayload = {
    state: crypto.randomUUID(),
    next: sanitizeRedirect(c.req.query("next") ?? undefined),
  };
  setCookie(c, OAUTH_COOKIE, encodeJsonCookie(payload), cookieOptions(c.req.raw, OAUTH_AGE_SECONDS));
  return c.redirect(getAuthorizationUrl(c.req.raw, c.env, payload));
});

app.get("/auth/google/callback", async (c) => {
  const oauthCookie = decodeJsonCookie(getCookie(c, OAUTH_COOKIE));
  const code = c.req.query("code");
  const state = c.req.query("state");
  const error = c.req.query("error");

  if (error) {
    deleteCookie(c, OAUTH_COOKIE, { path: "/" });
    return c.html(
      renderAuthPage({
        mode: "signin",
        error: `WorkOS returned: ${error}`,
        authConfigured: authConfigured(c.env),
        origin: new URL(c.req.url).origin,
      }),
      400,
    );
  }

  if (!oauthCookie || !code || !state || oauthCookie.state !== state) {
    deleteCookie(c, OAUTH_COOKIE, { path: "/" });
    return c.html(
      renderAuthPage({
        mode: "signin",
        error: "Sign-in state validation failed.",
        authConfigured: authConfigured(c.env),
        origin: new URL(c.req.url).origin,
      }),
      400,
    );
  }

  try {
    const authentication = await getWorkOS(c.env).userManagement.authenticateWithCode({
      clientId: c.env.WORKOS_CLIENT_ID,
      code,
    });

    if (!authentication.user.emailVerified) {
      throw new Error("The Google account email is not verified.");
    }

    const session = await storeRequest<WorkOSAuthStoreResponse>(c.env, "/workos-auth", {
      method: "POST",
      json: {
        workosUserId: authentication.user.id,
        email: authentication.user.email,
        name: displayName(authentication.user.email, authentication.user.firstName, authentication.user.lastName),
        avatarUrl: authentication.user.profilePictureUrl ?? undefined,
      },
    });

    setCookie(c, SESSION_COOKIE, session.sessionToken, cookieOptions(c.req.raw, SESSION_AGE_SECONDS));
    deleteCookie(c, OAUTH_COOKIE, { path: "/" });
    return c.redirect(session.viewer.onboardingComplete ? oauthCookie.next : "/onboarding");
  } catch (callbackError) {
    deleteCookie(c, OAUTH_COOKIE, { path: "/" });
    return c.html(
      renderAuthPage({
        mode: "signin",
        error: callbackError instanceof Error ? callbackError.message : "Managed sign-in failed.",
        authConfigured: authConfigured(c.env),
        origin: new URL(c.req.url).origin,
      }),
      400,
    );
  }
});

app.post("/auth/signout", async (c) => {
  const sessionToken = c.get("sessionToken") as string | undefined;
  if (sessionToken) {
    await storeRequest(c.env, "/signout", {
      method: "POST",
      json: { sessionToken },
    });
  }
  deleteCookie(c, SESSION_COOKIE, { path: "/" });
  return c.redirect("/");
});

app.post("/action/onboarding", async (c) => {
  const viewer = c.get("viewer") as Viewer | undefined;
  if (!viewer) {
    return redirectToSignIn(c);
  }
  const body = await formOrJson(c.req.raw);
  await storeRequest(c.env, "/onboarding", {
    method: "POST",
    json: { userId: viewer.id, bio: body.bio, interests: body.interests },
  });
  return c.redirect(body.redirect || "/");
});

app.post("/action/profile", async (c) => {
  const viewer = c.get("viewer") as Viewer | undefined;
  if (!viewer) {
    return redirectToSignIn(c);
  }
  const body = await formOrJson(c.req.raw);
  await storeRequest(c.env, "/profile", {
    method: "POST",
    json: { userId: viewer.id, bio: body.bio, interests: body.interests },
  });
  return c.redirect(body.redirect || `/u/${viewer.handle}`);
});

app.post("/action/save", async (c) => {
  const viewer = c.get("viewer") as Viewer | undefined;
  if (!viewer) {
    return redirectToSignIn(c);
  }
  const body = await formOrJson(c.req.raw);
  await storeRequest(c.env, "/toggle-save", {
    method: "POST",
    json: { userId: viewer.id, docId: body.docId },
  });
  return c.redirect(body.redirect || currentUrl(c));
});

app.post("/action/like", async (c) => {
  const viewer = c.get("viewer") as Viewer | undefined;
  if (!viewer) {
    return redirectToSignIn(c);
  }
  const body = await formOrJson(c.req.raw);
  await storeRequest(c.env, "/toggle-like", {
    method: "POST",
    json: { userId: viewer.id, docId: body.docId },
  });
  return c.redirect(body.redirect || currentUrl(c));
});

app.post("/action/collection", async (c) => {
  const viewer = c.get("viewer") as Viewer | undefined;
  if (!viewer) {
    return redirectToSignIn(c);
  }
  const body = await formOrJson(c.req.raw);
  await storeRequest(c.env, "/create-collection", {
    method: "POST",
    json: { userId: viewer.id, name: body.name },
  });
  return c.redirect(body.redirect || "/library");
});

app.post("/action/note", async (c) => {
  const viewer = c.get("viewer") as Viewer | undefined;
  if (!viewer) {
    return redirectToSignIn(c);
  }
  const body = await formOrJson(c.req.raw);
  await storeRequest(c.env, "/note", {
    method: "POST",
    json: { userId: viewer.id, docId: body.docId, anchor: body.anchor, text: body.text },
  });
  return c.redirect(body.redirect || `/doc/${body.docId}?panel=notes`);
});

app.post("/action/comment", async (c) => {
  const viewer = c.get("viewer") as Viewer | undefined;
  if (!viewer) {
    return redirectToSignIn(c);
  }
  const body = await formOrJson(c.req.raw);
  await storeRequest(c.env, "/comment", {
    method: "POST",
    json: { userId: viewer.id, docId: body.docId, text: body.text },
  });
  return c.redirect(body.redirect || `/doc/${body.docId}?panel=comments`);
});

app.post("/action/launch", async (c) => {
  const body = await formOrJson(c.req.raw);
  const query = body.query?.trim();
  if (!query) {
    return c.redirect("/");
  }
  if (looksLikeGutenbergUrl(query)) {
    if (!agentBackendConfigured(c.env)) {
      return c.redirect("/?importError=Book%20backend%20is%20not%20configured");
    }
    try {
      const book = await agentBackendRequest<BackendBookRecord>(c.env, "/books/import-gutenberg", {
        method: "POST",
        json: { url: query },
      });
      return c.redirect(`/book/${book.id}`);
    } catch (error) {
      const message = error instanceof Error ? error.message : "Import failed";
      return c.redirect(`/?importError=${encodeURIComponent(message)}`);
    }
  }
  return c.redirect(`/assistant?prompt=${encodeURIComponent(query)}`);
});

app.post("/action/import-book", async (c) => {
  const body = await formOrJson(c.req.raw);
  const url = body.url?.trim();
  if (!url) {
    return c.redirect("/?importError=Missing%20Gutenberg%20URL");
  }
  if (!agentBackendConfigured(c.env)) {
    return c.redirect("/?importError=Book%20backend%20is%20not%20configured");
  }

  try {
    const book = await agentBackendRequest<BackendBookRecord>(c.env, "/books/import-gutenberg", {
      method: "POST",
      json: { url },
    });
    return c.redirect(`/book/${book.id}`);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Import failed";
    return c.redirect(`/?importError=${encodeURIComponent(message)}`);
  }
});

app.post("/action/assistant", async (c) => {
  const viewer = c.get("viewer") as Viewer | undefined;
  if (!viewer) {
    return redirectToSignIn(c);
  }
  const body = await formOrJson(c.req.raw);
  const prompt = body.prompt?.trim();
  if (!prompt) {
    return c.redirect(body.redirect || "/assistant");
  }
  const importedBookId = importedBookIdFromDocId(body.docId || undefined);
  const reply = importedBookId
    ? await bookSearchReply(c.env, importedBookId, prompt)
    : buildAssistantReply(prompt, body.docId || undefined, "fast");

  const save = await storeRequest<{ thread: AssistantThread }>(c.env, "/assistant-save", {
    method: "POST",
    json: {
      userId: viewer.id,
      docId: body.docId || undefined,
      prompt,
      answer: reply.answer,
      citations: reply.citations,
      threadId: body.threadId || undefined,
      mode: "fast",
      status: "completed",
    },
  });

  if (importedBookId && agentBackendConfigured(c.env)) {
    try {
      const job = await agentBackendRequest<AgentJobRecord>(c.env, "/jobs", {
        method: "POST",
        json: {
          query: prompt,
          mode: "slow",
          book_id: importedBookId,
          top_books: 1,
          top_chunks: 8,
        },
      });
      await storeRequest<{ thread: AssistantThread }>(c.env, "/assistant-update", {
        method: "POST",
        json: {
          userId: viewer.id,
          threadId: save.thread.id,
          jobId: job.id,
          answer: "I am running a broader pass across the full book now.",
          citations: [],
          status: "pending",
        },
      });
    } catch {
      // Keep the grounded answer even if the deeper pass fails to start.
    }
  }

  return c.redirect(assistantRedirect(body.redirect, save.thread.id));
});

app.get("/api/health", async (c) => {
  return c.json({
    status: "ok",
    runtime: "cloudflare-worker-app",
    documents: listDocuments().length,
    surfaces: ["explore", "document", "assistant", "library", "profile"],
    auth: "workos-google",
    authConfigured: authConfigured(c.env),
    agentBackendConfigured: agentBackendConfigured(c.env),
  });
});

app.get("/api/feed", async (c) => {
  const requestedTab = c.req.query("tab");
  const tab: FeedTab = requestedTab === "likes" || requestedTab === "briefs" ? requestedTab : "hot";
  const viewer = c.get("viewer") as Viewer | undefined;
  const library = c.get("library") as UserLibrary | undefined;
  return c.json(
    getFeedDocuments(tab, c.get("stats"), {
      likedDocIds: library?.likedDocIds ?? [],
      savedDocIds: library?.savedDocIds ?? [],
      interests: viewer?.interests ?? [],
    }),
  );
});

app.get("/api/search", async (c) => {
  const q = c.req.query("q")?.trim();
  if (!q) {
    return c.json({ error: "Missing query" }, 400);
  }
  return c.json(runSearch(q));
});

app.get("/api/research", async (c) => {
  const q = c.req.query("q")?.trim();
  const requestedMode = c.req.query("mode");
  const mode: ResearchMode =
    requestedMode === "slow" || requestedMode === "naive" ? requestedMode : "fast";
  if (!q) {
    return c.json({ error: "Missing query" }, 400);
  }
  return c.json(runResearch(q, mode, c.req.query("docId") ?? undefined));
});

app.get("/api/doc/:id", async (c) => {
  const document = getDocument(c.req.param("id"));
  if (!document) {
    return c.json({ error: "Not found" }, 404);
  }
  return c.json(document);
});

app.get("/api/me", async (c) => {
  const viewer = c.get("viewer") as Viewer | undefined;
  const library = c.get("library") as UserLibrary | undefined;
  if (!viewer || !library) {
    return c.json({ viewer: null });
  }
  return c.json({ viewer, library });
});

app.get("/api/library", async (c) => {
  const viewer = c.get("viewer") as Viewer | undefined;
  const library = c.get("library") as UserLibrary | undefined;
  if (!viewer || !library) {
    return c.json({ error: "Unauthorized" }, 401);
  }
  return c.json({ viewer, library });
});

app.get("/api/profile/:handle", async (c) => {
  const profile = await storeRequest<ProfileResponse>(
    c.env,
    `/profile?handle=${encodeURIComponent(c.req.param("handle"))}`,
    undefined,
    true,
  );
  if (!profile.profile) {
    return c.json({ error: "Not found" }, 404);
  }
  return c.json(profile);
});

app.get("/api/comments/:docId", async (c) => {
  const viewer = c.get("viewer") as Viewer | undefined;
  const payload = await storeRequest<DocumentContextResponse>(
    c.env,
    `/document-context?docId=${encodeURIComponent(c.req.param("docId"))}${
      viewer ? `&userId=${encodeURIComponent(viewer.id)}` : ""
    }`,
  );
  return c.json(payload.comments);
});

app.post("/api/assistant", async (c) => {
  const viewer = c.get("viewer") as Viewer | undefined;
  if (!viewer) {
    return c.json({ error: "Unauthorized" }, 401);
  }
  const body = (await c.req.json()) as {
    prompt?: string;
    docId?: string;
    threadId?: string;
  };
  if (!body.prompt?.trim()) {
    return c.json({ error: "Missing prompt" }, 400);
  }
  const prompt = body.prompt;
  const importedBookId = importedBookIdFromDocId(body.docId);
  const reply = importedBookId
    ? await bookSearchReply(c.env, importedBookId, prompt)
    : buildAssistantReply(prompt, body.docId, "fast");
  const save = await storeRequest<{ thread: AssistantThread }>(c.env, "/assistant-save", {
    method: "POST",
    json: {
      userId: viewer.id,
      docId: body.docId,
      prompt,
      answer: reply.answer,
      citations: reply.citations,
      threadId: body.threadId,
      mode: "fast",
      status: "completed",
    },
  });

  let job: AgentJobRecord | undefined;
  if (importedBookId && agentBackendConfigured(c.env)) {
    try {
      job = await agentBackendRequest<AgentJobRecord>(c.env, "/jobs", {
        method: "POST",
        json: {
          query: prompt,
          mode: "slow",
          book_id: importedBookId,
          top_books: 1,
          top_chunks: 8,
        },
      });
      await storeRequest<{ thread: AssistantThread }>(c.env, "/assistant-update", {
        method: "POST",
        json: {
          userId: viewer.id,
          threadId: save.thread.id,
          jobId: job.id,
          answer: "I am running a broader pass across the full book now.",
          citations: [],
          status: "pending",
        },
      });
    } catch {
      job = undefined;
    }
  }

  return c.json({ reply, thread: save.thread, job });
});

app.notFound((c) => c.html(renderNotFound(c.get("viewer")), 404));

export default app;
