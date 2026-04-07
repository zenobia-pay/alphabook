import process from "node:process";

import { serve } from "@hono/node-server";

import { createLinuxApp, loadLinuxEnv } from "./linux-env";

const env = await loadLinuxEnv(process.cwd());
const port = Number(env.PORT ?? "8787");
const app = createLinuxApp(env);

serve({
  fetch: app.fetch,
  port,
}, (info) => {
  console.log(`alphabook linux api listening on http://127.0.0.1:${info.port}`);
});
