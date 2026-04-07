interface Env {
  FRONTEND_ORIGIN?: string;
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const incoming = new URL(request.url);
    const isApi = incoming.pathname.startsWith("/api/");
    const targetBase = env.FRONTEND_ORIGIN ?? "http://origin.alpha-book.org";
    const upstreamPath = isApi ? incoming.pathname.replace(/^\/api/u, "") || "/" : incoming.pathname;
    const upstream = new URL(upstreamPath + incoming.search, targetBase);

    const headers = new Headers(request.headers);
    headers.set("x-forwarded-host", incoming.host);
    headers.set("x-forwarded-proto", incoming.protocol.replace(/:$/u, ""));

    return fetch(upstream.toString(), {
      method: request.method,
      headers,
      body: request.body,
      redirect: "manual",
    });
  },
};
