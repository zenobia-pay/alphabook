import { createServer } from "node:http";
import { Readable } from "node:stream";
import type { ReadableStream as NodeReadableStream } from "node:stream/web";

import { createDemoWorkerApp } from "./dev-fixtures";

const port = Number(process.env.PORT ?? 8787);
const app = createDemoWorkerApp();

const server = createServer(async (request, response) => {
  try {
    const url = new URL(request.url ?? "/", `http://${request.headers.host ?? "127.0.0.1"}`);
    const body =
      request.method && ["GET", "HEAD"].includes(request.method.toUpperCase())
        ? undefined
        : (Readable.toWeb(request) as ReadableStream<Uint8Array>);

    const init: RequestInit = {
      method: request.method,
      headers: request.headers as HeadersInit,
      body,
    };
    const appResponse = await app.fetch(
      new Request(url, body ? ({ ...init, duplex: "half" } as RequestInit & { duplex: "half" }) : init),
    );

    response.statusCode = appResponse.status;
    appResponse.headers.forEach((value, key) => {
      response.setHeader(key, value);
    });

    if (!appResponse.body) {
      response.end();
      return;
    }

    Readable.fromWeb(appResponse.body as unknown as NodeReadableStream).pipe(response);
  } catch (error) {
    response.statusCode = 500;
    response.setHeader("content-type", "application/json; charset=utf-8");
    response.end(
      JSON.stringify({
        error: error instanceof Error ? error.message : "Unknown server error",
      }),
    );
  }
});

server.listen(port, "127.0.0.1", () => {
  console.log(`alphabook-orchestrator-worker dev server listening on http://127.0.0.1:${port}`);
});
