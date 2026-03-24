import { isStaleSpriteMachine } from "../../../apps/orchestrator-worker/src/runtime";

interface FlyMachine {
  id: string;
  name?: string;
  state?: string;
  created_at?: string;
  updated_at?: string;
  config?: {
    metadata?: Record<string, string>;
  } | null;
  incomplete_config?: {
    metadata?: Record<string, string>;
  } | null;
}

function readArg(name: string): string | null {
  const index = process.argv.indexOf(name);
  if (index === -1) {
    return null;
  }
  return process.argv[index + 1] ?? null;
}

async function flyRequest(
  apiToken: string,
  appName: string,
  path: string,
  init: RequestInit = {},
): Promise<Response> {
  const headers = new Headers(init.headers);
  headers.set("authorization", `Bearer ${apiToken}`);
  const response = await fetch(`https://api.machines.dev/v1/apps/${appName}${path}`, {
    ...init,
    headers,
    signal: AbortSignal.timeout(30_000),
  });
  if (!response.ok) {
    throw new Error(`Fly API request failed (${response.status}): ${await response.text()}`);
  }
  return response;
}

async function main() {
  const apiToken = process.env.FLY_API_TOKEN;
  if (!apiToken) {
    throw new Error("FLY_API_TOKEN is required.");
  }
  const appName = process.env.FLY_RUNTIME_APP_NAME ?? "alphabook-runtime";
  const keepSessionId = readArg("--keep-session") ?? "";
  const execute = !process.argv.includes("--dry-run");

  const response = await flyRequest(apiToken, appName, "/machines?summary=true", { method: "GET" });
  const machines = await response.json() as FlyMachine[];
  const staleMachines = machines.filter((machine) => isStaleSpriteMachine(machine, keepSessionId));

  const deleted: Array<{ id: string; name: string | null }> = [];
  for (const machine of staleMachines) {
    if (execute) {
      await flyRequest(apiToken, appName, `/machines/${machine.id}?force=true`, { method: "DELETE" });
    }
    deleted.push({
      id: machine.id,
      name: machine.name ?? null,
    });
  }

  process.stdout.write(
    `${JSON.stringify({
      appName,
      execute,
      keepSessionId: keepSessionId || null,
      staleMachineCount: staleMachines.length,
      deleted,
    }, null, 2)}\n`,
  );
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack || error.message : String(error));
  process.exit(1);
});
