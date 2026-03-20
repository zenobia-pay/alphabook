import { createCorpusAdapterRegistry } from "@alphabook/platform";
import { gutenbergCorpusAdapter } from "@alphabook/source-gutenberg/adapter";

export interface Env {
  ASSETS: {
    fetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response>;
  };
  BOOK_CONTENT_BUCKET: R2Bucket;
  API_ORIGIN?: string;
}

type RewriterElement = {
  setAttribute(name: string, value: string): void;
  append(content: string, options?: { html?: boolean }): void;
  before(content: string, options?: { html?: boolean }): void;
};

declare class HTMLRewriter {
  on(selector: string, handlers: { element?(element: RewriterElement): void }): HTMLRewriter;
  transform(response: Response): Response;
}

const SITE_ORIGIN = "https://alpha-book.org";
const BOOK_CONTENT_CACHE_TTL_SECONDS = 60 * 60 * 4;
const adapterRegistry = createCorpusAdapterRegistry({
  adapters: [gutenbergCorpusAdapter],
  defaultAdapterId: gutenbergCorpusAdapter.id,
});

type AssistantDocumentBootstrapPayload = {
  sessionId: string;
  runId: string;
  sessionTitle?: string;
  messages?: unknown[];
  runState?: unknown;
  error?: string;
  errorStatus?: number;
};

type AssistantSessionBootstrapPayload = {
  sessionId: string;
  sessions?: unknown[];
  messages?: unknown[];
  runs?: unknown[];
  runState?: unknown;
  error?: string;
  errorStatus?: number;
};

type WorkPageBootstrapPayload = {
  workId: string;
  work?: unknown;
  source?: unknown;
  error?: string;
  errorStatus?: number;
};

const BOOK_CONTENT_ORIGIN = "https://books.alpha-book.org";
const BOOK_CONTENT_VERSION = "20260320b";

function buildBookHtmlKey(gutenbergId: string) {
  return adapterRegistry.getDefault()?.artifactKeys.renderedDocument?.(gutenbergId) ?? `gutenberg/clean/${gutenbergId}/book.html`;
}

function resolveCanonicalUrl(requestUrl: URL) {
  if (requestUrl.pathname.startsWith("/works/") || requestUrl.pathname.startsWith("/u/")) {
    return new URL(`${requestUrl.pathname}${requestUrl.hash}`, SITE_ORIGIN).toString();
  }
  return `${SITE_ORIGIN}/`;
}

function escapeInlineJson(value: unknown) {
  return JSON.stringify(value)
    .replace(/</g, "\\u003c")
    .replace(/>/g, "\\u003e")
    .replace(/&/g, "\\u0026")
    .replace(/\u2028/g, "\\u2028")
    .replace(/\u2029/g, "\\u2029");
}

function escapeHtml(value: string) {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function firstNonEmptyString(...values: unknown[]) {
  for (const value of values) {
    if (typeof value === "string" && value.trim().length > 0) {
      return value.trim();
    }
  }
  return "";
}

function deriveDocumentTitle(bootstrap: AssistantDocumentBootstrapPayload) {
  const explicitTitle = firstNonEmptyString(bootstrap.sessionTitle);
  if (explicitTitle && explicitTitle.toLowerCase() !== "research log") {
    return explicitTitle;
  }
  const messages = Array.isArray(bootstrap.messages) ? bootstrap.messages : [];
  for (const message of messages) {
    if (!message || typeof message !== "object") {
      continue;
    }
    const record = message as { role?: unknown; content?: unknown };
    if (record.role !== "user" || typeof record.content !== "string") {
      continue;
    }
    const normalized = record.content.trim().replace(/\s+/g, " ");
    if (normalized) {
      return normalized.split(" ").slice(0, 8).join(" ");
    }
  }
  return explicitTitle || "Research log";
}

function deriveSessionTitle(bootstrap: AssistantSessionBootstrapPayload) {
  const sessions = Array.isArray(bootstrap.sessions) ? bootstrap.sessions : [];
  for (const session of sessions) {
    if (!session || typeof session !== "object") {
      continue;
    }
    const record = session as { id?: unknown; title?: unknown; lastMessagePreview?: unknown };
    if (record.id !== bootstrap.sessionId) {
      continue;
    }
    if (typeof record.title === "string" && record.title.trim().length > 0) {
      return record.title.trim();
    }
    if (typeof record.lastMessagePreview === "string" && record.lastMessagePreview.trim().length > 0) {
      return record.lastMessagePreview.trim().split(/\s+/).slice(0, 8).join(" ");
    }
  }
  const messages = Array.isArray(bootstrap.messages) ? bootstrap.messages : [];
  for (const message of messages) {
    if (!message || typeof message !== "object") {
      continue;
    }
    const record = message as { role?: unknown; content?: unknown };
    if (record.role !== "user" || typeof record.content !== "string") {
      continue;
    }
    const normalized = record.content.trim().replace(/\s+/g, " ");
    if (normalized) {
      return normalized.split(" ").slice(0, 8).join(" ");
    }
  }
  return "Research log";
}

function renderAssistantDocumentHtml(bootstrap: AssistantDocumentBootstrapPayload, html: string) {
  if (!html.trim()) {
    return null;
  }
  return [
    `<section class="assistant-document-pane assistant-document-standalone" data-ssr="assistant-document">`,
    `<div class="assistant-document-scroll">`,
    `<div class="assistant-document-inner">`,
    `<h1 class="assistant-document-entry is-title">${escapeHtml(deriveDocumentTitle(bootstrap))}</h1>`,
    `<div class="assistant-document-body">${html}</div>`,
    `</div>`,
    `</div>`,
    `</section>`,
  ].join("");
}

function renderAssistantDocumentMarkup(bootstrap: AssistantDocumentBootstrapPayload | null) {
  if (!bootstrap || bootstrap.error) {
    return null;
  }
  const runState = bootstrap.runState && typeof bootstrap.runState === "object"
    ? bootstrap.runState as { artifacts?: unknown }
    : null;
  const artifacts = Array.isArray(runState?.artifacts) ? runState.artifacts : [];
  for (const artifact of artifacts) {
    if (!artifact || typeof artifact !== "object") {
      continue;
    }
    const record = artifact as { filename?: unknown; content?: unknown; metadata?: unknown };
    const metadata = record.metadata && typeof record.metadata === "object"
      ? record.metadata as Record<string, unknown>
      : null;
    if (
      typeof record.content === "string"
      && record.content.trim().length > 0
      && (
        record.filename === "research-document.html"
        || (typeof record.filename === "string" && record.filename.endsWith("-research-document.html"))
        || metadata?.kind === "research_document"
      )
    ) {
      return renderAssistantDocumentHtml(bootstrap, record.content);
    }
  }
  const messages = Array.isArray(bootstrap.messages) ? bootstrap.messages : [];
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (!message || typeof message !== "object") {
      continue;
    }
    const metadata = (message as { metadata?: unknown }).metadata;
    if (!metadata || typeof metadata !== "object") {
      continue;
    }
    const html = typeof (metadata as { researchDocumentHtml?: unknown }).researchDocumentHtml === "string"
      ? (metadata as { researchDocumentHtml: string }).researchDocumentHtml
      : "";
    if (html.trim()) {
      return renderAssistantDocumentHtml(bootstrap, html);
    }
  }
  return null;
}

function renderMessageParagraphs(content: string) {
  return content
    .split(/\n{2,}/)
    .map((paragraph) => paragraph.trim())
    .filter(Boolean)
    .map((paragraph) => `<p>${escapeHtml(paragraph)}</p>`)
    .join("");
}

function renderAssistantSessionMarkup(bootstrap: AssistantSessionBootstrapPayload | null) {
  if (!bootstrap || bootstrap.error) {
    return null;
  }
  const documentBootstrap: AssistantDocumentBootstrapPayload = {
    sessionId: bootstrap.sessionId,
    runId: "",
    sessionTitle: deriveSessionTitle(bootstrap),
    messages: Array.isArray(bootstrap.messages) ? bootstrap.messages : [],
    runState: bootstrap.runState,
  };
  const documentMarkup = renderAssistantDocumentMarkup(documentBootstrap)
    ?? [
      `<section class="assistant-document-pane">`,
      `<div class="assistant-document-scroll"></div>`,
      `</section>`,
    ].join("");

  const messages = Array.isArray(bootstrap.messages) ? bootstrap.messages : [];
  const transcript = messages
    .filter((message) => {
      if (!message || typeof message !== "object") {
        return false;
      }
      const role = (message as { role?: unknown }).role;
      return role === "user" || role === "assistant";
    })
    .map((message, index) => {
      const record = message as { role?: unknown; content?: unknown };
      const role = record.role === "user" ? "user" : "assistant";
      const content = typeof record.content === "string" ? record.content.trim() : "";
      if (!content) {
        return "";
      }
      return [
        `<div class="message-row ${role === "user" ? "is-user" : "is-assistant"}" data-ssr-message="${index}">`,
        `<div class="message-card ${role === "user" ? "user-card" : "assistant-card"}">`,
        role === "assistant" ? `<div class="message-label">Assistant</div>` : "",
        `<div class="message-content">${renderMessageParagraphs(content)}</div>`,
        `</div>`,
        `</div>`,
      ].join("");
    })
    .filter(Boolean)
    .join("");

  return [
    `<section class="assistant-page" data-ssr="assistant-session">`,
    `<section class="assistant-workspace-page" style="--book-assistant-width:420px">`,
    `<div class="assistant-workspace-main">${documentMarkup}</div>`,
    `<div class="book-assistant-divider" role="presentation"></div>`,
    `<aside class="book-assistant-pane">`,
    `<div class="book-assistant-shell">`,
    `<div class="assistant-session-thread" data-testid="assistant-workspace-thread">${transcript}</div>`,
    `</div>`,
    `</aside>`,
    `</section>`,
    `</section>`,
  ].join("");
}

function buildWorkContentHref(workId: string, gutenbergId?: string | number | null) {
  if (gutenbergId != null && String(gutenbergId).trim().length > 0) {
    return `${BOOK_CONTENT_ORIGIN}/${encodeURIComponent(String(gutenbergId))}/?v=${BOOK_CONTENT_VERSION}`;
  }
  return `/api/works/${encodeURIComponent(workId)}/content?v=${BOOK_CONTENT_VERSION}`;
}

function renderWorkPageMarkup(bootstrap: WorkPageBootstrapPayload | null) {
  if (!bootstrap || bootstrap.error || !bootstrap.work || typeof bootstrap.work !== "object") {
    return null;
  }
  const work = bootstrap.work as { id?: unknown; title?: unknown; gutenbergId?: unknown };
  const workId = typeof work.id === "string" ? work.id : bootstrap.workId;
  const title = typeof work.title === "string" && work.title.trim().length > 0 ? work.title.trim() : "Book text";
  const frameHref = buildWorkContentHref(workId, typeof work.gutenbergId === "string" || typeof work.gutenbergId === "number" ? work.gutenbergId : null);
  return [
    `<section class="book-page" style="--book-assistant-width:420px" data-ssr="work-page">`,
    `<div class="book-reader-pane">`,
    `<div class="book-reader-surface">`,
    `<iframe class="book-reader-frame" src="${escapeHtml(frameHref)}" title="${escapeHtml(title)} text" loading="eager"></iframe>`,
    `</div>`,
    `</div>`,
    `<div class="book-assistant-divider" role="presentation"></div>`,
    `<aside class="book-assistant-pane"><div class="book-assistant-shell"></div></aside>`,
    `</section>`,
  ].join("");
}

async function fetchApiJson(request: Request, env: Env, path: string) {
  const upstreamOrigin = env.API_ORIGIN ?? "https://api.alpha-book.org";
  const upstreamUrl = new URL(path, upstreamOrigin);
  const response = await fetch(upstreamUrl.toString(), {
    method: "GET",
    headers: new Headers(request.headers),
    redirect: "manual",
  });
  const text = await response.text();
  let json: unknown = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = null;
  }
  return { status: response.status, ok: response.ok, json };
}

async function loadAssistantDocumentBootstrap(request: Request, env: Env, url: URL): Promise<AssistantDocumentBootstrapPayload | null> {
  if (url.searchParams.get("view") !== "assistant_document") {
    return null;
  }
  const sessionId = url.searchParams.get("session")?.trim();
  const runId = url.searchParams.get("run")?.trim();
  if (!sessionId || !runId) {
    return {
      sessionId: sessionId ?? "",
      runId: runId ?? "",
      error: "Missing session or run for this research document.",
      errorStatus: 400,
    };
  }

  const [messagesResponse, runStateResponse] = await Promise.all([
    fetchApiJson(request, env, `/sessions/${encodeURIComponent(sessionId)}/messages`),
    fetchApiJson(request, env, `/sessions/${encodeURIComponent(sessionId)}/runs/${encodeURIComponent(runId)}/document`),
  ]);

  const firstError = !runStateResponse.ok ? runStateResponse : !messagesResponse.ok ? messagesResponse : null;
  if (firstError) {
    const errorText =
      firstError.json && typeof firstError.json === "object" && typeof (firstError.json as { error?: unknown }).error === "string"
        ? (firstError.json as { error: string }).error
        : "We couldn't load this research document.";
    return {
      sessionId,
      runId,
      error: errorText,
      errorStatus: firstError.status,
    };
  }

  return {
    sessionId,
    runId,
    messages:
      messagesResponse.json && typeof messagesResponse.json === "object" && Array.isArray((messagesResponse.json as { messages?: unknown[] }).messages)
        ? (messagesResponse.json as { messages: unknown[] }).messages
        : [],
    runState: runStateResponse.json ?? undefined,
  };
}

function pickPreferredRun(runs: unknown[]) {
  const normalized = runs.filter((run): run is Record<string, unknown> => Boolean(run) && typeof run === "object");
  const active = normalized.find((run) => run.status === "running" || run.status === "queued");
  if (active) {
    return active;
  }
  return [...normalized].sort((left, right) => {
    const leftStartedAt = typeof left.startedAt === "string" ? left.startedAt : "";
    const rightStartedAt = typeof right.startedAt === "string" ? right.startedAt : "";
    return rightStartedAt.localeCompare(leftStartedAt);
  })[0] ?? null;
}

async function loadAssistantSessionBootstrap(request: Request, env: Env, url: URL): Promise<AssistantSessionBootstrapPayload | null> {
  if (url.searchParams.get("view") !== "assistant") {
    return null;
  }
  const sessionId = url.searchParams.get("session")?.trim();
  if (!sessionId) {
    return null;
  }

  const [sessionsResponse, messagesResponse, runsResponse] = await Promise.all([
    fetchApiJson(request, env, "/sessions"),
    fetchApiJson(request, env, `/sessions/${encodeURIComponent(sessionId)}/messages`),
    fetchApiJson(request, env, `/sessions/${encodeURIComponent(sessionId)}/runs`),
  ]);

  const firstError = !messagesResponse.ok
    ? messagesResponse
    : !runsResponse.ok
      ? runsResponse
      : !sessionsResponse.ok
        ? sessionsResponse
        : null;
  if (firstError) {
    const errorText =
      firstError.json && typeof firstError.json === "object" && typeof (firstError.json as { error?: unknown }).error === "string"
        ? (firstError.json as { error: string }).error
        : "We couldn't load this conversation.";
    return {
      sessionId,
      error: errorText,
      errorStatus: firstError.status,
    };
  }

  const runs =
    runsResponse.json && typeof runsResponse.json === "object" && Array.isArray((runsResponse.json as { runs?: unknown[] }).runs)
      ? (runsResponse.json as { runs: unknown[] }).runs
      : [];
  const preferredRun = pickPreferredRun(runs);
  const preferredRunId = preferredRun && typeof preferredRun.id === "string" ? preferredRun.id : null;
  const runStateResponse = preferredRunId
    ? await fetchApiJson(request, env, `/sessions/${encodeURIComponent(sessionId)}/runs/${encodeURIComponent(preferredRunId)}`)
    : null;
  if (runStateResponse && !runStateResponse.ok) {
    const errorText =
      runStateResponse.json && typeof runStateResponse.json === "object" && typeof (runStateResponse.json as { error?: unknown }).error === "string"
        ? (runStateResponse.json as { error: string }).error
        : "We couldn't load this conversation.";
    return {
      sessionId,
      error: errorText,
      errorStatus: runStateResponse.status,
    };
  }

  return {
    sessionId,
    sessions:
      sessionsResponse.json && typeof sessionsResponse.json === "object" && Array.isArray((sessionsResponse.json as { sessions?: unknown[] }).sessions)
        ? (sessionsResponse.json as { sessions: unknown[] }).sessions
        : [],
    messages:
      messagesResponse.json && typeof messagesResponse.json === "object" && Array.isArray((messagesResponse.json as { messages?: unknown[] }).messages)
        ? (messagesResponse.json as { messages: unknown[] }).messages
        : [],
    runs,
    runState: runStateResponse?.json ?? undefined,
  };
}

async function loadWorkPageBootstrap(request: Request, env: Env, url: URL): Promise<WorkPageBootstrapPayload | null> {
  const pathnameMatch = url.pathname.match(/^\/works\/([^/]+)$/);
  if (!pathnameMatch) {
    return null;
  }
  const workId = decodeURIComponent(pathnameMatch[1]).trim();
  if (!workId) {
    return null;
  }
  const workResponse = await fetchApiJson(request, env, `/works/${encodeURIComponent(workId)}`);
  if (!workResponse.ok) {
    const errorText =
      workResponse.json && typeof workResponse.json === "object" && typeof (workResponse.json as { error?: unknown }).error === "string"
        ? (workResponse.json as { error: string }).error
        : "We couldn't load that book.";
    return {
      workId,
      error: errorText,
      errorStatus: workResponse.status,
    };
  }
  const payload = workResponse.json && typeof workResponse.json === "object"
    ? workResponse.json as { work?: unknown; source?: unknown }
    : {};
  return {
    workId,
    work: payload.work,
    source: payload.source ?? null,
  };
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname.startsWith("/book-content-static/")) {
      const cached = await caches.default.match(request);
      if (cached) {
        return cached;
      }

      const gutenbergId = decodeURIComponent(url.pathname.slice("/book-content-static/".length)).trim();
      if (!/^\d+$/.test(gutenbergId)) {
        return new Response("Invalid book content id.", { status: 400 });
      }

      const object = await env.BOOK_CONTENT_BUCKET.get(buildBookHtmlKey(gutenbergId));
      if (!object) {
        return new Response("Book content not found.", { status: 404 });
      }

      const headers = new Headers();
      object.writeHttpMetadata(headers);
      headers.set("content-type", headers.get("content-type") ?? "text/html; charset=utf-8");
      headers.set("cache-control", `public, max-age=${BOOK_CONTENT_CACHE_TTL_SECONDS}`);
      headers.set("x-alphabook-surface", "frontend-worker-static-book-content");
      if (object.httpEtag) {
        headers.set("etag", object.httpEtag);
      }

      const response = new Response(object.body, {
        status: 200,
        headers,
      });
      ctx.waitUntil(caches.default.put(request, response.clone()));
      return response;
    }

    if (url.pathname === "/api" || url.pathname.startsWith("/api/")) {
      const upstreamOrigin = env.API_ORIGIN ?? "https://api.alpha-book.org";
      const upstreamUrl = new URL(upstreamOrigin);
      upstreamUrl.pathname = url.pathname.replace(/^\/api/, "") || "/";
      upstreamUrl.search = url.search;

      return fetch(upstreamUrl.toString(), {
        method: request.method,
        headers: request.headers,
        body: request.method === "GET" || request.method === "HEAD" ? undefined : request.body,
        redirect: "manual",
      });
    }

    const [response, assistantDocumentBootstrap, assistantSessionBootstrap, workPageBootstrap] = await Promise.all([
      env.ASSETS.fetch(request),
      loadAssistantDocumentBootstrap(request, env, url).catch(() => null),
      loadAssistantSessionBootstrap(request, env, url).catch(() => null),
      loadWorkPageBootstrap(request, env, url).catch(() => null),
    ]);
    const headers = new Headers(response.headers);
    headers.set("x-alphabook-surface", "frontend-worker");
    const canonicalUrl = resolveCanonicalUrl(url);
    const robots = url.searchParams.get("view") === "admin" ? "noindex, nofollow" : "index, follow";
    headers.set("x-robots-tag", robots);

    const contentType = headers.get("content-type") ?? "";
    let injectedAssistantDocumentBootstrap = false;
    let injectedAssistantSessionBootstrap = false;
    let injectedWorkPageBootstrap = false;
    const assistantDocumentMarkup = renderAssistantDocumentMarkup(assistantDocumentBootstrap);
    const assistantSessionMarkup = renderAssistantSessionMarkup(assistantSessionBootstrap);
    const workPageMarkup = renderWorkPageMarkup(workPageBootstrap);
    const body = contentType.includes("text/html")
      ? new HTMLRewriter()
        .on("link[rel='canonical']", {
          element(element) {
            element.setAttribute("href", canonicalUrl);
          },
        })
        .on("meta[property='og:url']", {
          element(element) {
            element.setAttribute("content", canonicalUrl);
          },
        })
        .on("meta[name='robots']", {
          element(element) {
            element.setAttribute("content", robots);
          },
        })
        .on("script[type='module'][src]", {
          element(element) {
            const scripts: string[] = [];
            if (assistantDocumentBootstrap && !injectedAssistantDocumentBootstrap) {
              scripts.push(`<script>window.__ALPHABOOK_ASSISTANT_DOCUMENT_BOOTSTRAP__=${escapeInlineJson(assistantDocumentBootstrap)};</script>`);
              injectedAssistantDocumentBootstrap = true;
            }
            if (assistantSessionBootstrap && !injectedAssistantSessionBootstrap) {
              scripts.push(`<script>window.__ALPHABOOK_ASSISTANT_SESSION_BOOTSTRAP__=${escapeInlineJson(assistantSessionBootstrap)};</script>`);
              injectedAssistantSessionBootstrap = true;
            }
            if (workPageBootstrap && !injectedWorkPageBootstrap) {
              scripts.push(`<script>window.__ALPHABOOK_WORK_PAGE_BOOTSTRAP__=${escapeInlineJson(workPageBootstrap)};</script>`);
              injectedWorkPageBootstrap = true;
            }
            if (scripts.length === 0) {
              return;
            }
            element.before(scripts.join(""), { html: true });
          },
        })
        .on("head", {
          element(element) {
            const scripts: string[] = [];
            if (assistantDocumentBootstrap && !injectedAssistantDocumentBootstrap) {
              scripts.push(`<script>window.__ALPHABOOK_ASSISTANT_DOCUMENT_BOOTSTRAP__=${escapeInlineJson(assistantDocumentBootstrap)};</script>`);
              injectedAssistantDocumentBootstrap = true;
            }
            if (assistantSessionBootstrap && !injectedAssistantSessionBootstrap) {
              scripts.push(`<script>window.__ALPHABOOK_ASSISTANT_SESSION_BOOTSTRAP__=${escapeInlineJson(assistantSessionBootstrap)};</script>`);
              injectedAssistantSessionBootstrap = true;
            }
            if (workPageBootstrap && !injectedWorkPageBootstrap) {
              scripts.push(`<script>window.__ALPHABOOK_WORK_PAGE_BOOTSTRAP__=${escapeInlineJson(workPageBootstrap)};</script>`);
              injectedWorkPageBootstrap = true;
            }
            if (scripts.length === 0) {
              return;
            }
            element.append(scripts.join(""), { html: true });
          },
        })
        .on("div#root", {
          element(element) {
            const markup: string[] = [];
            if (assistantDocumentMarkup) {
              markup.push(`<div id="assistant-document-ssr">${assistantDocumentMarkup}</div>`);
            }
            if (assistantSessionMarkup) {
              markup.push(`<div id="assistant-session-ssr">${assistantSessionMarkup}</div>`);
            }
            if (workPageMarkup) {
              markup.push(`<div id="work-page-ssr">${workPageMarkup}</div>`);
            }
            if (markup.length === 0) {
              return;
            }
            element.before(markup.join(""), { html: true });
          },
        })
        .transform(response).body
      : response.body;

    return new Response(body, {
      status: response.status,
      statusText: response.statusText,
      headers,
    });
  },
};
