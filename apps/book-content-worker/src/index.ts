import { getImplementationConfig } from "@alphabook/implementations";
import { getCorpusAdapter } from "@alphabook/shared";

export interface Env {
  BOOK_CONTENT_BUCKET: R2Bucket;
  IMPLEMENTATION_ID?: string;
  SITE_ORIGIN?: string;
}

const CACHE_TTL_SECONDS = 60 * 60 * 4;

function resolveImplementation(env: Env) {
  return getImplementationConfig(env.IMPLEMENTATION_ID);
}

function resolveCorpusAdapter(env: Env) {
  return getCorpusAdapter(resolveImplementation(env).adapterId);
}

function resolveSiteOrigin(env: Env) {
  return env.SITE_ORIGIN ?? resolveImplementation(env).siteOrigin;
}

function buildRenderedDocumentKey(env: Env, externalId: string) {
  return resolveCorpusAdapter(env)?.artifactKeys.renderedDocument?.(externalId) ?? `gutenberg/clean/${externalId}/book.html`;
}

function buildRenderedManifestKey(env: Env, externalId: string) {
  return resolveCorpusAdapter(env)?.artifactKeys.renderedManifest?.(externalId) ?? `gutenberg/clean/${externalId}/book/manifest.json`;
}

function buildRenderedPageKey(env: Env, externalId: string, pageNumber: number) {
  return resolveCorpusAdapter(env)?.artifactKeys.renderedPage?.(externalId, pageNumber)
    ?? `gutenberg/clean/${externalId}/book/pages/page-${String(pageNumber).padStart(4, "0")}.html`;
}

function parseContentRoute(pathname: string, env: Env) {
  const trimmed = pathname.replace(/^\/+|\/+$/g, "");
  if (!trimmed) {
    return null;
  }
  const parts = trimmed.split("/");
  const externalId = parts[0]?.endsWith(".html") ? parts[0].slice(0, -".html".length) : parts[0];
  const externalIdPattern = resolveCorpusAdapter(env)?.capabilities?.staticContent?.externalIdPattern ?? /^\d+$/u;
  if (!externalIdPattern.test(externalId)) {
    return null;
  }
  if (parts.length === 1) {
    return { externalId, kind: "landing" as const };
  }
  if (parts[1] === "manifest.json") {
    return { externalId, kind: "manifest" as const };
  }
  if (parts[1] === "pages" && /^page-\d{4}\.html$/.test(parts[2] ?? "")) {
    return {
      externalId,
      kind: "page" as const,
      pageNumber: Number((parts[2] ?? "").match(/\d+/)?.[0] ?? "1"),
    };
  }
  if (parts[1] === "passages" && parts[2]) {
    return {
      externalId,
      kind: "passage" as const,
      passageId: decodeURIComponent(parts[2]),
    };
  }
  return { externalId, kind: "landing" as const };
}

async function getStaticObject(env: Env, key: string) {
  return await env.BOOK_CONTENT_BUCKET.get(key);
}

async function serveStaticObject(
  request: Request,
  env: Env,
  ctx: ExecutionContext,
  object: R2ObjectBody | R2Object,
  surface: string,
) {
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
    `default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src 'self' data: https:; font-src https: data:; base-uri 'none'; object-src 'none'; frame-ancestors ${resolveSiteOrigin(env)}`,
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
    const route = parseContentRoute(url.pathname, env);

    if (!route) {
      return new Response("Content not found.", {
        status: 404,
        headers: {
          "content-type": "text/plain; charset=utf-8",
          "cache-control": "public, max-age=300",
        },
      });
    }

    if (route.kind === "passage") {
      const manifest = await env.BOOK_CONTENT_BUCKET.get(buildRenderedManifestKey(env, route.externalId));
      if (!manifest) {
        return new Response("Content not found.", {
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
        ? new URL(`${url.origin}/${route.externalId}/${match.href.replace(/^\.\//, "")}#${encodeURIComponent(route.passageId)}`)
        : new URL(`${url.origin}/${route.externalId}/`);
      return Response.redirect(destination.toString(), 302);
    }

    if (route.kind === "landing" && !url.pathname.endsWith("/")) {
      return Response.redirect(`${url.origin}/${route.externalId}/`, 302);
    }

    const key =
      route.kind === "landing"
        ? buildRenderedDocumentKey(env, route.externalId)
        : route.kind === "manifest"
          ? buildRenderedManifestKey(env, route.externalId)
          : buildRenderedPageKey(env, route.externalId, route.pageNumber);
    const object = await getStaticObject(env, key);
    if (!object) {
      return new Response("Content not found.", {
        status: 404,
        headers: {
          "content-type": "text/plain; charset=utf-8",
          "cache-control": "public, max-age=300",
        },
      });
    }

    return serveStaticObject(
      request,
      env,
      ctx,
      object,
      route.kind === "page"
        ? "content-worker-static-page"
        : route.kind === "manifest"
          ? "content-worker-static-manifest"
          : "content-worker-static-document",
    );
  },
};
