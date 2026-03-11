import { DurableObject } from "cloudflare:workers";
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
  type AssistantReply,
  type DocumentCard,
  type DocumentStats,
  type FeedTab,
  type RailPanel,
  type ResearchMode,
  type SeedDocument,
  type SearchResponse,
  type DocumentView,
  type AssistantCitation,
} from "./app/data";
import {
  renderAssistantPage,
  renderAuthPage,
  renderDocumentPage,
  renderHomePage,
  renderLabsPage,
  renderLibraryPage,
  renderNotFound,
  renderOnboardingPage,
  renderProfilePage,
  renderSearchPage,
  type AssistantMessage,
  type AssistantThread,
  type CommentRecord,
  type LibraryCollection,
  type NoteRecord,
  type Viewer,
} from "./app/render";

interface Env {
  APP_STATE: DurableObjectNamespace<AppState>;
}

interface StoredUser extends Viewer {
  passwordHash: string;
  createdAt: string;
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
}

type AppVariables = {
  viewer?: Viewer;
  library?: UserLibrary;
  stats: Record<string, DocumentStats>;
  sessionToken?: string;
};

type AppContext = Context<{ Bindings: Env; Variables: AppVariables }>;

const SESSION_COOKIE = "ab_session";
const SESSION_AGE_SECONDS = 60 * 60 * 24 * 30;

function defaultLibrary(): UserLibrary {
  const createdAt = new Date().toISOString();
  return {
    savedDocIds: [],
    likedDocIds: [],
    collections: [
      { id: crypto.randomUUID(), name: "Queue", docIds: [], createdAt },
      { id: crypto.randomUUID(), name: "Field Notes", docIds: [], createdAt },
      { id: crypto.randomUUID(), name: "Long Reads", docIds: [], createdAt },
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

function stripPassword(user: StoredUser): Viewer {
  return {
    id: user.id,
    name: user.name,
    handle: user.handle,
    email: user.email,
    bio: user.bio,
    interests: user.interests,
    onboardingComplete: user.onboardingComplete,
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

async function hashPassword(password: string): Promise<string> {
  const bytes = new TextEncoder().encode(password);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map((value) => value.toString(16).padStart(2, "0")).join("");
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

export class AppState extends DurableObject<Env> {
  constructor(state: DurableObjectState, env: Env) {
    super(state, env);
  }

  private async loadDb(): Promise<StoreDb> {
    return (await this.ctx.storage.get<StoreDb>("db")) ?? emptyDb();
  }

  private async saveDb(db: StoreDb): Promise<void> {
    await this.ctx.storage.put("db", db);
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const db = await this.loadDb();

    if (url.pathname === "/snapshot" && request.method === "GET") {
      const token = url.searchParams.get("sessionToken");
      const stats = combineStats(db);
      if (!token) {
        return Response.json({ stats } satisfies SnapshotResponse);
      }
      const session = db.sessions.find((record) => record.token === token && new Date(record.expiresAt) > new Date());
      if (!session) {
        return Response.json({ stats } satisfies SnapshotResponse);
      }
      const user = db.users.find((candidate) => candidate.id === session.userId);
      if (!user) {
        return Response.json({ stats } satisfies SnapshotResponse);
      }
      return Response.json({
        viewer: stripPassword(user),
        library: ensureLibrary(db, user.id),
        stats,
      } satisfies SnapshotResponse);
    }

    if (url.pathname === "/signup" && request.method === "POST") {
      const body = await jsonFromRequest(request);
      const email = String(body.email || "").trim().toLowerCase();
      const name = String(body.name || "").trim();
      const passwordHash = String(body.passwordHash || "");
      if (!email || !name || !passwordHash) {
        return Response.json({ error: "Missing required fields." }, { status: 400 });
      }
      if (db.users.some((user) => user.email === email)) {
        return Response.json({ error: "An account with that email already exists." }, { status: 409 });
      }
      const user: StoredUser = {
        id: crypto.randomUUID(),
        handle: uniqueHandle(name, db),
        email,
        name,
        bio: "Building a personal research graph across books and papers.",
        interests: [],
        onboardingComplete: false,
        passwordHash,
        createdAt: new Date().toISOString(),
      };
      const session: SessionRecord = {
        token: crypto.randomUUID(),
        userId: user.id,
        createdAt: new Date().toISOString(),
        expiresAt: new Date(Date.now() + SESSION_AGE_SECONDS * 1000).toISOString(),
      };
      db.users.push(user);
      db.sessions.push(session);
      db.libraries[user.id] = defaultLibrary();
      await this.saveDb(db);
      return Response.json({ viewer: stripPassword(user), sessionToken: session.token });
    }

    if (url.pathname === "/signin" && request.method === "POST") {
      const body = await jsonFromRequest(request);
      const email = String(body.email || "").trim().toLowerCase();
      const passwordHash = String(body.passwordHash || "");
      const user = db.users.find((candidate) => candidate.email === email);
      if (!user || user.passwordHash !== passwordHash) {
        return Response.json({ error: "Invalid email or password." }, { status: 401 });
      }
      const session: SessionRecord = {
        token: crypto.randomUUID(),
        userId: user.id,
        createdAt: new Date().toISOString(),
        expiresAt: new Date(Date.now() + SESSION_AGE_SECONDS * 1000).toISOString(),
      };
      db.sessions.push(session);
      await this.saveDb(db);
      return Response.json({ viewer: stripPassword(user), sessionToken: session.token });
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
      return Response.json({ viewer: stripPassword(user) });
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
      if (interests.length) {
        user.interests = interests;
      }
      await this.saveDb(db);
      return Response.json({ viewer: stripPassword(user) });
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
        library.collections[0]?.docIds.includes(docId) || library.collections[0]?.docIds.unshift(docId);
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
        { role: "assistant", content: answer, citations, createdAt: now },
      );
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
        profile: stripPassword(user),
        stats: {
          saved: library.savedDocIds.length,
          notes: library.notes.length,
          comments: commentCount,
          collections: library.collections.length,
          threads: library.threads.length,
        },
        collectionNames: library.collections.map((collection) => collection.name),
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

function redirectToSignIn(c: AppContext) {
  return c.redirect("/signin");
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

function currentUrl(c: AppContext): string {
  return new URL(c.req.url).pathname + new URL(c.req.url).search;
}

app.get("/", async (c) => {
  const tab = (c.req.query("tab") as FeedTab | undefined) ?? "hot";
  const q = c.req.query("q");
  const cards = getFeedDocuments(tab, c.get("stats"), {
    likedDocIds: c.get("library")?.likedDocIds ?? [],
    savedDocIds: c.get("library")?.savedDocIds ?? [],
    interests: c.get("viewer")?.interests ?? [],
  });
  return c.html(renderHomePage({ viewer: c.get("viewer"), activeTab: tab, documents: cards, search: q ? runSearch(q) : undefined }));
});

app.get("/search", async (c) => {
  const q = c.req.query("q")?.trim() || "melancholy and grief";
  const cards = documentCardsForViewer(c);
  return c.html(renderSearchPage({ viewer: c.get("viewer"), query: q, search: runSearch(q), feedDocuments: cards }));
});

app.get("/doc/:id", async (c) => {
  const docId = c.req.param("id");
  const panel = (c.req.query("panel") as RailPanel | undefined) ?? "assistant";
  const view = (c.req.query("view") as DocumentView | undefined) ?? "document";
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
  const thread = c.get("library")?.threads.find((candidate) => candidate.docId === docId);
  const related = document.relatedIds.map((relatedId) => cardById[relatedId]).filter(Boolean);

  return c.html(
    renderDocumentPage({
      viewer,
      document,
      view,
      panel,
      sections: context.sections,
      related,
      search: q ? runSearch(q) : undefined,
      notes: docContext.notes,
      comments: docContext.comments,
      thread,
    }),
  );
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
  const activeThread = threadId
    ? threadsResponse.threads.find((thread) => thread.id === threadId)
    : threadsResponse.threads[0];
  return c.html(
    renderAssistantPage({
      viewer,
      availableDocs: cards,
      threads: threadsResponse.threads,
      activeThread,
      activeDocId: c.req.query("docId") ?? undefined,
      prompt: c.req.query("prompt") ?? undefined,
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
  return c.html(
    renderProfilePage({
      viewer,
      profile: profileResponse.profile,
      ownProfile: viewer?.id === profileResponse.profile.id,
      stats: profileResponse.stats,
      collectionNames: profileResponse.collectionNames,
    }),
  );
});

app.get("/labs", async (c) => {
  return c.html(renderLabsPage({ viewer: c.get("viewer"), documents: documentCardsForViewer(c) }));
});

app.get("/signin", async (c) => {
  if (c.get("viewer")) {
    return c.redirect("/");
  }
  return c.html(renderAuthPage({ mode: "signin" }));
});

app.get("/signup", async (c) => {
  if (c.get("viewer")) {
    return c.redirect("/");
  }
  return c.html(renderAuthPage({ mode: "signup" }));
});

app.get("/onboarding", async (c) => {
  const viewer = c.get("viewer") as Viewer | undefined;
  if (!viewer) {
    return redirectToSignIn(c);
  }
  return c.html(renderOnboardingPage({ viewer }));
});

app.post("/auth/signup", async (c) => {
  const body = await formOrJson(c.req.raw);
  try {
    const response = await storeRequest<{ viewer: Viewer; sessionToken: string }>(c.env, "/signup", {
      method: "POST",
      json: {
        name: body.name,
        email: body.email,
        passwordHash: await hashPassword(body.password),
      },
    });
    setCookie(c, SESSION_COOKIE, response.sessionToken, {
      path: "/",
      maxAge: SESSION_AGE_SECONDS,
      sameSite: "Lax",
      httpOnly: true,
      secure: true,
    });
    return c.redirect("/onboarding");
  } catch (error) {
    return c.html(renderAuthPage({ mode: "signup", error: error instanceof Error ? error.message : "Signup failed." }), 400);
  }
});

app.post("/auth/signin", async (c) => {
  const body = await formOrJson(c.req.raw);
  try {
    const response = await storeRequest<{ viewer: Viewer; sessionToken: string }>(c.env, "/signin", {
      method: "POST",
      json: {
        email: body.email,
        passwordHash: await hashPassword(body.password),
      },
    });
    setCookie(c, SESSION_COOKIE, response.sessionToken, {
      path: "/",
      maxAge: SESSION_AGE_SECONDS,
      sameSite: "Lax",
      httpOnly: true,
      secure: true,
    });
    return c.redirect("/");
  } catch (error) {
    return c.html(renderAuthPage({ mode: "signin", error: error instanceof Error ? error.message : "Signin failed." }), 401);
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

app.post("/action/assistant", async (c) => {
  const viewer = c.get("viewer") as Viewer | undefined;
  if (!viewer) {
    return redirectToSignIn(c);
  }
  const body = await formOrJson(c.req.raw);
  const reply = buildAssistantReply(body.prompt, body.docId || undefined);
  const save = await storeRequest<{ thread: AssistantThread }>(c.env, "/assistant-save", {
    method: "POST",
    json: {
      userId: viewer.id,
      docId: body.docId || undefined,
      prompt: body.prompt,
      answer: reply.answer,
      citations: reply.citations,
      threadId: body.threadId || undefined,
    },
  });
  if (body.redirect) {
    const redirect = body.redirect.includes("/assistant")
      ? `${body.redirect}${body.redirect.includes("?") ? "&" : "?"}threadId=${save.thread.id}`
      : body.redirect;
    return c.redirect(redirect);
  }
  return c.redirect(`/assistant?threadId=${save.thread.id}`);
});

app.get("/api/health", async (c) => {
  return c.json({
    status: "ok",
    runtime: "cloudflare-worker-app",
    documents: listDocuments().length,
    surfaces: ["explore", "document", "assistant", "library", "profile", "labs"],
    auth: "cookie-session + durable object",
  });
});

app.get("/api/feed", async (c) => {
  const tab = (c.req.query("tab") as FeedTab | undefined) ?? "hot";
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
  const mode = (c.req.query("mode") as ResearchMode | undefined) ?? "fast";
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
  const body = (await c.req.json()) as { prompt?: string; docId?: string; threadId?: string };
  if (!body.prompt?.trim()) {
    return c.json({ error: "Missing prompt" }, 400);
  }
  const reply = buildAssistantReply(body.prompt, body.docId);
  const save = await storeRequest<{ thread: AssistantThread }>(c.env, "/assistant-save", {
    method: "POST",
    json: {
      userId: viewer.id,
      docId: body.docId,
      prompt: body.prompt,
      answer: reply.answer,
      citations: reply.citations,
      threadId: body.threadId,
    },
  });
  return c.json({ reply, thread: save.thread });
});

app.notFound((c) => c.html(renderNotFound(c.get("viewer")), 404));

export default app;
