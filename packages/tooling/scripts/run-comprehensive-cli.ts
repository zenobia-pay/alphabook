import process from "node:process";
import { readFile } from "node:fs/promises";

import { loadDotEnvFile } from "./lib/benchmark-env.ts";

type Args = {
  prompt?: string;
  apiBaseUrl?: string;
  cookie?: string;
  sessionId?: string;
  userId?: string;
  workIds: string[];
  mode: "semantic" | "comprehensive" | "hermes";
  intensityOverride?: "normal" | "high" | "maximum";
  semanticBackend?: "alphaloop" | "context1";
  rawEvents: boolean;
  cancelOnSigint: boolean;
};

type CurrentUserResponse = {
  authenticated?: boolean;
  user?: {
    id?: string | null;
    email?: string | null;
    name?: string | null;
  } | null;
};

type StreamEvent = {
  event: string;
  data: Record<string, unknown>;
};

function usage(): never {
  console.error(
    [
      "Usage:",
      "  npm run research:comprehensive -- --prompt \"Find me examples...\"",
      "",
      "Options:",
      "  --prompt <text>              User prompt to send to the live /chat endpoint",
      "  --api-base-url <url>         API base URL (default https://api.alpha-book.org)",
      "  --cookie <cookie>            Explicit alphabook_session cookie string",
      "  --session-id <uuid>          Continue an existing session",
      "  --user-id <id>               Explicit user id when auth is disabled",
      "  --work-id <id>               Scope the run to a work id (repeatable)",
      "  --mode <mode>                semantic | comprehensive | hermes (default comprehensive)",
      "  --intensity-override <lvl>   normal | high | maximum",
      "  --semantic-backend <name>    alphaloop | context1",
      "  --raw-events                 Print every SSE payload as JSON",
      "  --no-cancel-on-sigint        Do not try to cancel the run on Ctrl-C",
      "",
      "Environment:",
      "  ALPHABOOK_COOKIE",
      "  ALPHABOOK_API_BASE_URL",
    ].join("\n"),
  );
  process.exit(1);
}

function parseArgs(argv: string[]): Args {
  const args: Args = {
    workIds: [],
    mode: "comprehensive",
    rawEvents: false,
    cancelOnSigint: true,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const next = argv[index + 1];
    if ((arg === "--prompt" || arg === "-p") && next) {
      args.prompt = next;
      index += 1;
      continue;
    }
    if (arg === "--api-base-url" && next) {
      args.apiBaseUrl = next;
      index += 1;
      continue;
    }
    if (arg === "--cookie" && next) {
      args.cookie = next;
      index += 1;
      continue;
    }
    if (arg === "--session-id" && next) {
      args.sessionId = next;
      index += 1;
      continue;
    }
    if (arg === "--user-id" && next) {
      args.userId = next;
      index += 1;
      continue;
    }
    if (arg === "--work-id" && next) {
      args.workIds.push(next);
      index += 1;
      continue;
    }
    if (arg === "--mode" && next && (next === "semantic" || next === "comprehensive" || next === "hermes")) {
      args.mode = next;
      index += 1;
      continue;
    }
    if (arg === "--intensity-override" && next && (next === "normal" || next === "high" || next === "maximum")) {
      args.intensityOverride = next;
      index += 1;
      continue;
    }
    if (arg === "--semantic-backend" && next && (next === "alphaloop" || next === "context1")) {
      args.semanticBackend = next;
      index += 1;
      continue;
    }
    if (arg === "--raw-events") {
      args.rawEvents = true;
      continue;
    }
    if (arg === "--no-cancel-on-sigint") {
      args.cancelOnSigint = false;
      continue;
    }
    if (!arg.startsWith("-") && !args.prompt) {
      args.prompt = arg;
      continue;
    }
    usage();
  }

  if (!args.prompt) {
    usage();
  }
  return args;
}

async function readCookieFromDevVars(): Promise<string | null> {
  try {
    const text = await readFile(".dev.vars", "utf8");
    for (const line of text.split(/\r?\n/u)) {
      if (line.startsWith("ALPHABOOK_COOKIE=")) {
        return line.slice("ALPHABOOK_COOKIE=".length).trim().replace(/^["']|["']$/gu, "");
      }
    }
  } catch {
    return null;
  }
  return null;
}

async function resolveConfig(args: Args) {
  try {
    await loadDotEnvFile(".dev.vars");
  } catch {
    // Optional for local tooling.
  }
  const apiBaseUrl = (args.apiBaseUrl || process.env.ALPHABOOK_API_BASE_URL || "https://api.alpha-book.org").replace(/\/+$/u, "");
  const cookie = args.cookie || process.env.ALPHABOOK_COOKIE || await readCookieFromDevVars();
  return { apiBaseUrl, cookie: cookie ?? null };
}

async function fetchCurrentUser(apiBaseUrl: string, cookie: string | null): Promise<CurrentUserResponse | null> {
  if (!cookie) {
    return null;
  }
  const response = await fetch(`${apiBaseUrl}/me`, {
    headers: {
      Cookie: cookie,
      Origin: "https://alpha-book.org",
      Referer: "https://alpha-book.org/",
      "User-Agent": "Mozilla/5.0",
      Accept: "application/json,text/plain,*/*",
    },
  });
  if (!response.ok) {
    return null;
  }
  return await response.json() as CurrentUserResponse;
}

function printHeader(title: string) {
  process.stdout.write(`\n=== ${title} ===\n`);
}

function summarizeEvent(event: StreamEvent): string {
  const data = event.data;
  if (event.event === "session.created") {
    return `session=${typeof data.sessionId === "string" ? data.sessionId : "unknown"}`;
  }
  if (event.event === "run.started") {
    return `run=${typeof data.runId === "string" ? data.runId : "unknown"} status=running`;
  }
  if (event.event === "router.completed") {
    return `router=${typeof data.type === "string" ? data.type : "unknown"}`;
  }
  if (event.event === "assistant.delta") {
    const delta = typeof data.delta === "string" ? data.delta : typeof data.content === "string" ? data.content : "";
    return delta;
  }
  if (event.event === "assistant.completed") {
    return typeof data.content === "string" ? data.content : "assistant completed";
  }
  if (event.event === "tool.started") {
    return `tool=${typeof data.toolName === "string" ? data.toolName : "unknown"} started`;
  }
  if (event.event === "tool.completed") {
    return `tool=${typeof data.toolName === "string" ? data.toolName : "unknown"} completed`;
  }
  if (event.event === "tool.progress") {
    return typeof data.message === "string" ? data.message : "tool progress";
  }
  if (event.event === "run.completed") {
    return `run=${typeof data.runId === "string" ? data.runId : "unknown"} status=${typeof data.status === "string" ? data.status : "completed"}`;
  }
  if (event.event === "error") {
    return typeof data.message === "string" ? data.message : JSON.stringify(data);
  }
  return JSON.stringify(data);
}

async function cancelRun(apiBaseUrl: string, cookie: string | null, runId: string) {
  const response = await fetch(`${apiBaseUrl}/runs/${encodeURIComponent(runId)}/cancel`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(cookie ? {
        Cookie: cookie,
        Origin: "https://alpha-book.org",
        Referer: "https://alpha-book.org/",
        "User-Agent": "Mozilla/5.0",
        Accept: "application/json,text/plain,*/*",
      } : {}),
    },
    body: JSON.stringify({}),
  });
  if (!response.ok) {
    throw new Error(await response.text());
  }
}

async function streamChat(
  apiBaseUrl: string,
  payload: Record<string, unknown>,
  cookie: string | null,
  onEvent: (event: StreamEvent) => Promise<void> | void,
) {
  const response = await fetch(`${apiBaseUrl}/chat`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(cookie ? {
        Cookie: cookie,
        Origin: "https://alpha-book.org",
        Referer: "https://alpha-book.org/",
        "User-Agent": "Mozilla/5.0",
        Accept: "text/event-stream,application/json,text/plain,*/*",
      } : {}),
    },
    body: JSON.stringify(payload),
  });
  if (!response.ok) {
    throw new Error(await response.text());
  }
  const reader = response.body?.getReader();
  if (!reader) {
    throw new Error("Response stream was not available.");
  }

  const decoder = new TextDecoder();
  let buffer = "";

  while (true) {
    const { value, done } = await reader.read();
    if (done) {
      break;
    }
    buffer += decoder.decode(value, { stream: true });
    let boundary = buffer.indexOf("\n\n");
    while (boundary >= 0) {
      const rawEvent = buffer.slice(0, boundary);
      buffer = buffer.slice(boundary + 2);
      boundary = buffer.indexOf("\n\n");

      const eventName = rawEvent
        .split("\n")
        .find((line) => line.startsWith("event:"))
        ?.replace("event:", "")
        .trim();
      const dataLine = rawEvent
        .split("\n")
        .find((line) => line.startsWith("data:"))
        ?.replace("data:", "")
        .trim();
      if (!eventName || !dataLine) {
        continue;
      }
      await onEvent({
        event: eventName,
        data: JSON.parse(dataLine) as Record<string, unknown>,
      });
    }
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const config = await resolveConfig(args);
  const currentUser = await fetchCurrentUser(config.apiBaseUrl, config.cookie);

  const payload: Record<string, unknown> = {
    message: args.prompt,
    mode: args.mode,
  };
  if (args.sessionId) {
    payload.sessionId = args.sessionId;
  }
  if (args.userId) {
    payload.userId = args.userId;
  }
  if (args.workIds.length > 0) {
    payload.workIds = args.workIds;
  }
  if (args.intensityOverride) {
    payload.intensityOverride = args.intensityOverride;
  }
  if (args.semanticBackend) {
    payload.semanticBackend = args.semanticBackend;
  }

  printHeader("Comprehensive Run Started");
  process.stdout.write(`api=${config.apiBaseUrl}\n`);
  process.stdout.write(`mode=${args.mode}\n`);
  if (currentUser?.authenticated) {
    process.stdout.write(`user=${currentUser.user?.email || currentUser.user?.id || "authenticated"}\n`);
  } else if (payload.userId) {
    process.stdout.write(`user=${String(payload.userId)}\n`);
  } else {
    process.stdout.write("user=anonymous\n");
  }

  let activeRunId = "";
  let activeSessionId = args.sessionId ?? "";
  let cancelRequested = false;

  const onSigint = async () => {
    if (!args.cancelOnSigint || !activeRunId) {
      process.exit(130);
      return;
    }
    if (cancelRequested) {
      return;
    }
    cancelRequested = true;
    process.stderr.write(`\nCancelling run ${activeRunId}...\n`);
    try {
      await cancelRun(config.apiBaseUrl, config.cookie, activeRunId);
    } catch (error) {
      process.stderr.write(`Failed to cancel run: ${error instanceof Error ? error.message : String(error)}\n`);
    }
    process.exit(130);
  };
  process.on("SIGINT", () => {
    void onSigint();
  });

  await streamChat(config.apiBaseUrl, payload, config.cookie, async (event) => {
    if (event.event === "session.created" && typeof event.data.sessionId === "string") {
      activeSessionId = event.data.sessionId;
    }
    if (event.event === "run.started" && typeof event.data.runId === "string") {
      activeRunId = event.data.runId;
    }
    if (args.rawEvents) {
      process.stdout.write(`${JSON.stringify(event)}\n`);
      return;
    }
    const line = summarizeEvent(event);
    if (!line) {
      return;
    }
    if (event.event === "assistant.delta") {
      process.stdout.write(line);
      return;
    }
    if (event.event === "assistant.completed") {
      process.stdout.write(`\n[assistant.completed] ${line}\n`);
      return;
    }
    process.stdout.write(`[${event.event}] ${line}\n`);
  });

  printHeader("Comprehensive Run Finished");
  if (activeSessionId) {
    process.stdout.write(`session=${activeSessionId}\n`);
  }
  if (activeRunId) {
    process.stdout.write(`run=${activeRunId}\n`);
  }
}

void main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
