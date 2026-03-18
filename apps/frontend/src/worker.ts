export interface Env {
  ASSETS: {
    fetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response>;
  };
  API_ORIGIN?: string;
}

type WorkDetail = {
  id: string;
  title: string;
  subtitle?: string | null;
  authors: string[];
  language?: string | null;
  releaseDate?: string | null;
  summary?: string | null;
  coverImageUrl?: string | null;
  gutenbergId?: number | null;
  subjects?: string[];
  bookshelves?: string[];
};

type WorkSource = {
  format: "html" | "text";
  content: string;
};

type WorkDetailResponse = {
  work?: WorkDetail;
};

type WorkSourceResponse = {
  source?: WorkSource | null;
};

type RewriterElement = {
  setAttribute(name: string, value: string): void;
};

declare class HTMLRewriter {
  on(selector: string, handlers: { element?(element: RewriterElement): void }): HTMLRewriter;
  transform(response: Response): Response;
}

const SITE_ORIGIN = "https://alpha-book.org";
const STATIC_WORK_CACHE_NAME = "alphabook-static-works";
const STATIC_WORK_REVALIDATE_SECONDS = 60 * 60;
const STATIC_WORK_BROWSER_CACHE_SECONDS = 60 * 5;

function resolveApiOrigin(env: Env) {
  return env.API_ORIGIN ?? "https://api.alpha-book.org";
}

function resolveCanonicalUrl(requestUrl: URL) {
  if (requestUrl.pathname.startsWith("/works/") || requestUrl.pathname.startsWith("/u/")) {
    return new URL(`${requestUrl.pathname}${requestUrl.hash}`, SITE_ORIGIN).toString();
  }
  return `${SITE_ORIGIN}/`;
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

function createExcerpt(value: string, maxLength = 240) {
  const normalized = normalizeWhitespace(stripTags(value));
  if (normalized.length <= maxLength) {
    return normalized;
  }
  return `${normalized.slice(0, maxLength - 1).trimEnd()}…`;
}

function formatBookMeta(work: WorkDetail) {
  const meta = [
    typeof work.gutenbergId === "number" ? `Project Gutenberg #${work.gutenbergId}` : null,
    work.language ? work.language.toUpperCase() : null,
    work.releaseDate ? work.releaseDate.slice(0, 4) : null,
  ].filter((value): value is string => Boolean(value));
  return meta.join(" · ");
}

function renderTagList(values: string[] | undefined, className: string) {
  const tags = (values ?? []).filter((value) => value.trim().length > 0).slice(0, 8);
  if (tags.length === 0) {
    return "";
  }
  return `
    <div class="${className}">
      ${tags.map((value) => `<span>${escapeHtml(value)}</span>`).join("")}
    </div>
  `;
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

function renderTextSource(content: string) {
  const paragraphs = content
    .replace(/\r\n/g, "\n")
    .split(/\n{2,}/)
    .map((paragraph) => paragraph.trim())
    .filter((paragraph) => paragraph.length > 0);

  if (paragraphs.length === 0) {
    return `<p class="empty-state">This work does not have stored source content yet.</p>`;
  }

  return paragraphs
    .map((paragraph) => {
      const escaped = escapeHtml(paragraph).replace(/\n/g, "<br />");
      return `<p>${escaped}</p>`;
    })
    .join("\n");
}

function renderSourceMarkup(source: WorkSource | null | undefined) {
  if (!source?.content) {
    return `<p class="empty-state">This work does not have stored source content yet.</p>`;
  }
  return source.format === "html"
    ? sanitizeSourceHtml(source.content)
    : renderTextSource(source.content);
}

function buildWorkContentCanonicalUrl(workId: string) {
  return new URL(`/works/${encodeURIComponent(workId)}`, SITE_ORIGIN).toString();
}

function buildStaticWorkHtml(work: WorkDetail, source: WorkSource | null | undefined) {
  const canonicalUrl = buildWorkContentCanonicalUrl(work.id);
  const authors = work.authors.filter((author) => author.trim().length > 0);
  const byline = authors.length > 0 ? authors.join(" · ") : "Unknown author";
  const meta = formatBookMeta(work);
  const description = createExcerpt(work.summary ?? source?.content ?? `Read ${work.title} on alpha book.`);
  const title = `${work.title} | alpha book`;
  const sourceMarkup = renderSourceMarkup(source);

  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>${escapeHtml(title)}</title>
    <meta name="description" content="${escapeHtml(description)}" />
    <meta name="robots" content="noindex,nofollow" />
    <link rel="canonical" href="${escapeHtml(canonicalUrl)}" />
    <style>
      :root {
        color-scheme: light;
        --bg: #f8f4ee;
        --ink: #1f1b16;
        --muted: #635848;
        --line: rgba(73, 58, 41, 0.14);
        --accent-soft: rgba(143, 79, 42, 0.12);
      }
      * { box-sizing: border-box; }
      body {
        margin: 0;
        font-family: Georgia, "Times New Roman", serif;
        color: var(--ink);
        background: var(--bg);
      }
      a { color: inherit; }
      .page {
        width: min(880px, calc(100vw - 40px));
        margin: 0 auto;
        padding: 28px 0 40px;
      }
      .hero {
        display: grid;
        gap: 10px;
        padding-bottom: 22px;
      }
      .eyebrow, .byline, .summary {
        margin: 0;
        color: var(--muted);
        font-size: 1rem;
        line-height: 1.7;
      }
      h1 {
        margin: 0;
        font-size: clamp(2rem, 4vw, 3.5rem);
        line-height: 0.98;
      }
      .chip-row {
        display: flex;
        flex-wrap: wrap;
        gap: 10px;
      }
      .chip-row span {
        display: inline-flex;
        align-items: center;
        border-radius: 999px;
        padding: 8px 12px;
        background: var(--accent-soft);
        color: var(--muted);
        font-size: 0.88rem;
      }
      .reader-body {
        padding: 0 0 32px;
        font-size: 1.1rem;
        line-height: 1.85;
      }
      .reader-body h1, .reader-body h2, .reader-body h3, .reader-body h4, .reader-body h5, .reader-body h6 {
        font-size: 1.4em;
        line-height: 1.2;
        margin: 1.8em 0 0.75em;
      }
      .reader-body p, .reader-body li, .reader-body blockquote, .reader-body pre {
        margin: 0 0 1.15em;
      }
      .reader-body blockquote {
        margin-left: 0;
        padding-left: 18px;
        border-left: 3px solid var(--accent-soft);
        color: var(--muted);
      }
      .reader-body pre {
        white-space: pre-wrap;
        font-family: "Courier New", monospace;
        background: #f2eadf;
        border-radius: 16px;
        padding: 16px;
      }
      .empty-state {
        color: var(--muted);
      }
      @media (max-width: 780px) {
        .page { width: min(100vw - 24px, 100%); }
      }
    </style>
  </head>
  <body>
    <main class="page">
      <section class="hero">
        ${meta ? `<p class="eyebrow">${escapeHtml(meta)}</p>` : ""}
        <h1>${escapeHtml(work.title)}</h1>
        ${work.subtitle ? `<p class="summary">${escapeHtml(work.subtitle)}</p>` : ""}
        <p class="byline">${escapeHtml(byline)}</p>
        ${work.summary ? `<p class="summary">${escapeHtml(work.summary)}</p>` : ""}
        ${renderTagList(work.bookshelves, "chip-row")}
      </section>
      <div class="reader-body">${sourceMarkup}</div>
    </main>
  </body>
</html>`;
}

function buildStaticResponse(body: string, canonicalUrl: string) {
  return new Response(body, {
    headers: {
      "content-type": "text/html; charset=utf-8",
      "cache-control": `public, max-age=${STATIC_WORK_BROWSER_CACHE_SECONDS}, s-maxage=${STATIC_WORK_REVALIDATE_SECONDS}`,
      "x-robots-tag": "noindex, nofollow",
      "x-alphabook-surface": "frontend-worker-static-work",
      vary: "accept-encoding",
      "x-canonical-url": canonicalUrl,
    },
  });
}

async function fetchJson<T>(url: string): Promise<T | null> {
  const response = await fetch(url, {
    headers: {
      accept: "application/json",
    },
  });
  if (response.status === 404) {
    return null;
  }
  if (!response.ok) {
    throw new Error(`Request failed for ${url}: ${response.status}`);
  }
  return await response.json() as T;
}

async function renderStaticWorkResponse(request: Request, env: Env, url: URL) {
  const workIdMatch = url.pathname.match(/^\/work-content\/([^/]+)$/);
  if (!workIdMatch) {
    return null;
  }

  const cacheKeyUrl = new URL(url.toString());
  cacheKeyUrl.search = "";
  const cacheKey = new Request(cacheKeyUrl.toString(), {
    method: request.method,
    headers: request.headers,
  });
  const cache = await caches.open(STATIC_WORK_CACHE_NAME);
  const cached = await cache.match(cacheKey);
  if (cached) {
    return cached;
  }

  const workId = decodeURIComponent(workIdMatch[1]);
  const apiOrigin = resolveApiOrigin(env);
  const [detailPayload, sourcePayload] = await Promise.all([
    fetchJson<WorkDetailResponse>(`${apiOrigin}/works/${encodeURIComponent(workId)}`),
    fetchJson<WorkSourceResponse>(`${apiOrigin}/works/${encodeURIComponent(workId)}/source`),
  ]);

  if (!detailPayload?.work) {
    return new Response("Work not found.", {
      status: 404,
      headers: {
        "content-type": "text/plain; charset=utf-8",
        "cache-control": "public, max-age=60, s-maxage=60",
        "x-alphabook-surface": "frontend-worker-static-work-miss",
      },
    });
  }

  const body = buildStaticWorkHtml(detailPayload.work, sourcePayload?.source ?? null);
  const response = buildStaticResponse(body, buildWorkContentCanonicalUrl(detailPayload.work.id));
  await cache.put(cacheKey, response.clone());
  return response;
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

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

    if (request.method === "GET" && url.pathname.startsWith("/work-content/")) {
      const staticResponse = await renderStaticWorkResponse(request, env, url);
      if (staticResponse) {
        return staticResponse;
      }
    }

    const response = await env.ASSETS.fetch(request);
    const headers = new Headers(response.headers);
    headers.set("x-alphabook-surface", "frontend-worker");
    const canonicalUrl = resolveCanonicalUrl(url);
    const robots = url.searchParams.get("view") === "admin" ? "noindex, nofollow" : "index, follow";
    headers.set("x-robots-tag", robots);

    const contentType = headers.get("content-type") ?? "";
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
        .transform(response).body
      : response.body;

    return new Response(body, {
      status: response.status,
      statusText: response.statusText,
      headers,
    });
  },
};
