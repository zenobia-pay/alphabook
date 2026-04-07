import process from "node:process";

import { serve } from "@hono/node-server";

import { createLinuxApp, loadLinuxEnv } from "./linux-env";

const env = await loadLinuxEnv(process.cwd());
const port = Number(env.PORT ?? "8787");
const hostname = process.env.HOST ?? "0.0.0.0";
const app = createLinuxApp(env);

serve({
  fetch: app.fetch,
  hostname,
  port,
}, (info) => {
  console.log(`alphabook linux api listening on http://${hostname}:${info.port}`);
});
