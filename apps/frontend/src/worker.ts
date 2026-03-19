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

type AssistantDocumentBootstrapPayload = {
  sessionId: string;
  runId: string;
  sessionTitle?: string;
  messages?: unknown[];
  runState?: unknown;
  error?: string;
  errorStatus?: number;
};

function buildBookHtmlKey(gutenbergId: string) {
  return `gutenberg/clean/${gutenbergId}/book.html`;
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

function renderAssistantDocumentText(bootstrap: AssistantDocumentBootstrapPayload, text: string) {
  if (!text.trim()) {
    return null;
  }
  return [
    `<section class="assistant-document-pane assistant-document-standalone" data-ssr="assistant-document">`,
    `<div class="assistant-document-scroll">`,
    `<div class="assistant-document-inner">`,
    `<h1 class="assistant-document-entry is-title">${escapeHtml(deriveDocumentTitle(bootstrap))}</h1>`,
    `<div class="assistant-document-body">${escapeHtml(text)}</div>`,
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
        record.filename === "research-document.md"
        || (typeof record.filename === "string" && record.filename.endsWith("-research-document.md"))
        || metadata?.kind === "research_document"
      )
    ) {
      return renderAssistantDocumentText(bootstrap, record.content);
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
    const text = typeof (metadata as { researchDocumentText?: unknown }).researchDocumentText === "string"
      ? (metadata as { researchDocumentText: string }).researchDocumentText
      : "";
    if (text.trim()) {
      return renderAssistantDocumentText(bootstrap, text);
    }
  }
  return null;
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

    const [response, assistantDocumentBootstrap] = await Promise.all([
      env.ASSETS.fetch(request),
      loadAssistantDocumentBootstrap(request, env, url).catch(() => null),
    ]);
    const headers = new Headers(response.headers);
    headers.set("x-alphabook-surface", "frontend-worker");
    const canonicalUrl = resolveCanonicalUrl(url);
    const robots = url.searchParams.get("view") === "admin" ? "noindex, nofollow" : "index, follow";
    headers.set("x-robots-tag", robots);

    const contentType = headers.get("content-type") ?? "";
    let injectedAssistantDocumentBootstrap = false;
    const assistantDocumentMarkup = renderAssistantDocumentMarkup(assistantDocumentBootstrap);
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
            if (!assistantDocumentBootstrap || injectedAssistantDocumentBootstrap) {
              return;
            }
            element.before(
              `<script>window.__ALPHABOOK_ASSISTANT_DOCUMENT_BOOTSTRAP__=${escapeInlineJson(assistantDocumentBootstrap)};</script>`,
              { html: true },
            );
            injectedAssistantDocumentBootstrap = true;
          },
        })
        .on("head", {
          element(element) {
            if (!assistantDocumentBootstrap || injectedAssistantDocumentBootstrap) {
              return;
            }
            element.append(
              `<script>window.__ALPHABOOK_ASSISTANT_DOCUMENT_BOOTSTRAP__=${escapeInlineJson(assistantDocumentBootstrap)};</script>`,
              { html: true },
            );
            injectedAssistantDocumentBootstrap = true;
          },
        })
        .on("div#root", {
          element(element) {
            if (!assistantDocumentMarkup) {
              return;
            }
            element.before(`<div id="assistant-document-ssr">${assistantDocumentMarkup}</div>`, { html: true });
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
