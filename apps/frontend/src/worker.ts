export interface Env {
  ASSETS: {
    fetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response>;
  };
  API_ORIGIN?: string;
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === "/skill.md") {
      const upstreamOrigin = env.API_ORIGIN ?? "https://api.alpha-book.org";
      const upstreamUrl = new URL("/skill.md", upstreamOrigin);
      return fetch(upstreamUrl.toString(), {
        method: "GET",
        headers: request.headers,
        redirect: "manual",
      });
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

    const response = await env.ASSETS.fetch(request);
    const headers = new Headers(response.headers);
    headers.set("x-alphabook-surface", "frontend-worker");
    return new Response(response.body, {
      status: response.status,
      statusText: response.statusText,
      headers,
    });
  },
};
