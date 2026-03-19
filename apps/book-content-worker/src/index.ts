export interface Env {
  BOOK_CONTENT_BUCKET: R2Bucket;
}

const CACHE_TTL_SECONDS = 60 * 60 * 4;

function buildBookHtmlKey(gutenbergId: string) {
  return `gutenberg/clean/${gutenbergId}/book.html`;
}

function parseGutenbergId(pathname: string) {
  const trimmed = pathname.replace(/^\/+|\/+$/g, "");
  if (!trimmed) {
    return null;
  }

  const candidate = trimmed.endsWith(".html") ? trimmed.slice(0, -".html".length) : trimmed;
  return /^\d+$/.test(candidate) ? candidate : null;
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    const gutenbergId = parseGutenbergId(url.pathname);

    if (!gutenbergId) {
      return new Response("Book content not found.", {
        status: 404,
        headers: {
          "content-type": "text/plain; charset=utf-8",
          "cache-control": "public, max-age=300",
        },
      });
    }

    const cacheKey = new Request(url.toString(), {
      method: "GET",
      headers: request.headers,
    });
    const edgeCache = caches as unknown as { default: Cache };
    const cached = await edgeCache.default.match(cacheKey);
    if (cached) {
      return cached;
    }

    const object = await env.BOOK_CONTENT_BUCKET.get(buildBookHtmlKey(gutenbergId));
    if (!object) {
      return new Response("Book content not found.", {
        status: 404,
        headers: {
          "content-type": "text/plain; charset=utf-8",
          "cache-control": "public, max-age=300",
        },
      });
    }

    const headers = new Headers();
    object.writeHttpMetadata(headers);
    headers.set("content-type", headers.get("content-type") ?? "text/html; charset=utf-8");
    headers.set("cache-control", `public, max-age=${CACHE_TTL_SECONDS}`);
    headers.set("x-alphabook-surface", "book-content-worker-static-book");
    headers.set(
      "content-security-policy",
      "default-src 'none'; style-src 'unsafe-inline'; img-src 'self' data: https:; font-src https: data:; frame-ancestors https://alpha-book.org",
    );
    headers.delete("x-frame-options");
    if (object.httpEtag) {
      headers.set("etag", object.httpEtag);
    }

    const response = new Response(object.body, {
      status: 200,
      headers,
    });
    ctx.waitUntil(edgeCache.default.put(cacheKey, response.clone()));
    return response;
  },
};
