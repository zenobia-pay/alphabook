export interface Env {
  BOOK_CONTENT_BUCKET: R2Bucket;
}

const CACHE_TTL_SECONDS = 60 * 60 * 4;

function buildBookHtmlKey(gutenbergId: string) {
  return `gutenberg/clean/${gutenbergId}/book.html`;
}

function buildBookManifestKey(gutenbergId: string) {
  return `gutenberg/clean/${gutenbergId}/book/manifest.json`;
}

function buildBookPageKey(gutenbergId: string, pageNumber: number) {
  return `gutenberg/clean/${gutenbergId}/book/pages/page-${String(pageNumber).padStart(4, "0")}.html`;
}

function parseBookRoute(pathname: string) {
  const trimmed = pathname.replace(/^\/+|\/+$/g, "");
  if (!trimmed) {
    return null;
  }
  const parts = trimmed.split("/");
  const gutenbergId = parts[0]?.endsWith(".html") ? parts[0].slice(0, -".html".length) : parts[0];
  if (!/^\d+$/.test(gutenbergId)) {
    return null;
  }
  if (parts.length === 1) {
    return { gutenbergId, kind: "landing" as const };
  }
  if (parts[1] === "manifest.json") {
    return { gutenbergId, kind: "manifest" as const };
  }
  if (parts[1] === "pages" && /^page-\d{4}\.html$/.test(parts[2] ?? "")) {
    return {
      gutenbergId,
      kind: "page" as const,
      pageNumber: Number((parts[2] ?? "").match(/\d+/)?.[0] ?? "1"),
    };
  }
  if (parts[1] === "passages" && parts[2]) {
    return {
      gutenbergId,
      kind: "passage" as const,
      passageId: decodeURIComponent(parts[2]),
    };
  }
  return { gutenbergId, kind: "landing" as const };
}

async function getStaticObject(env: Env, key: string) {
  return await env.BOOK_CONTENT_BUCKET.get(key);
}

async function serveStaticObject(request: Request, ctx: ExecutionContext, object: R2ObjectBody | R2Object, surface: string) {
  const cacheKey = new Request(request.url, {
    method: "GET",
    headers: request.headers,
  });
  const edgeCache = caches as unknown as { default: Cache };
  const cached = await edgeCache.default.match(cacheKey);
  if (cached) {
    return cached;
  }

  const headers = new Headers();
  object.writeHttpMetadata(headers);
  headers.set("content-type", headers.get("content-type") ?? "text/html; charset=utf-8");
  headers.set("cache-control", `public, max-age=${CACHE_TTL_SECONDS}`);
  headers.set("x-alphabook-surface", surface);
  headers.set(
    "content-security-policy",
    "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src 'self' data: https:; font-src https: data:; base-uri 'none'; object-src 'none'; frame-ancestors https://alpha-book.org",
  );
  headers.delete("x-frame-options");
  if (object.httpEtag) {
    headers.set("etag", object.httpEtag);
  }

  const response = new Response("body" in object ? object.body : null, {
    status: 200,
    headers,
  });
  ctx.waitUntil(edgeCache.default.put(cacheKey, response.clone()));
  return response;
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    const route = parseBookRoute(url.pathname);

    if (!route) {
      return new Response("Book content not found.", {
        status: 404,
        headers: {
          "content-type": "text/plain; charset=utf-8",
          "cache-control": "public, max-age=300",
        },
      });
    }

    if (route.kind === "passage") {
      const manifest = await env.BOOK_CONTENT_BUCKET.get(buildBookManifestKey(route.gutenbergId));
      if (!manifest) {
        return new Response("Book content not found.", {
          status: 404,
          headers: {
            "content-type": "text/plain; charset=utf-8",
            "cache-control": "public, max-age=300",
          },
        });
      }
      const payload = await manifest.json<{
        passages?: Record<string, { href?: string }>;
      }>();
      const match = payload.passages?.[route.passageId];
      const destination = match?.href
        ? new URL(`${url.origin}/${route.gutenbergId}/${match.href.replace(/^\.\//, "")}#${encodeURIComponent(route.passageId)}`)
        : new URL(`${url.origin}/${route.gutenbergId}/`);
      return Response.redirect(destination.toString(), 302);
    }

    if (route.kind === "landing" && !url.pathname.endsWith("/")) {
      return Response.redirect(`${url.origin}/${route.gutenbergId}/`, 302);
    }

    const key =
      route.kind === "landing"
        ? buildBookHtmlKey(route.gutenbergId)
        : route.kind === "manifest"
          ? buildBookManifestKey(route.gutenbergId)
          : buildBookPageKey(route.gutenbergId, route.pageNumber);
    const object = await getStaticObject(env, key);
    if (!object) {
      return new Response("Book content not found.", {
        status: 404,
        headers: {
          "content-type": "text/plain; charset=utf-8",
          "cache-control": "public, max-age=300",
        },
      });
    }

    return serveStaticObject(
      request,
      ctx,
      object,
      route.kind === "page"
        ? "book-content-worker-static-page"
        : route.kind === "manifest"
          ? "book-content-worker-static-manifest"
          : "book-content-worker-static-book",
    );
  },
};
