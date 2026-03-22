import { mkdirSync, existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";

type Args = {
  id: string;
  productName: string;
  siteOrigin: string;
  apiOrigin: string;
  contentOrigin: string;
  accountId: string;
};

function readArg(flag: string) {
  const index = process.argv.indexOf(flag);
  if (index === -1) {
    return null;
  }
  return process.argv[index + 1] ?? null;
}

function requiredArg(flag: string) {
  const value = readArg(flag);
  if (!value) {
    throw new Error(`Missing required argument: ${flag}`);
  }
  return value;
}

function normalizeId(raw: string) {
  return raw.trim().toLowerCase().replace(/[^a-z0-9-]+/gu, "-");
}

function buildArgs(): Args {
  const id = normalizeId(requiredArg("--id"));
  const productName = readArg("--product-name")?.trim() || id.split("-").map((part) => part[0]?.toUpperCase() + part.slice(1)).join("");
  const siteOrigin = requiredArg("--site-origin");
  const apiOrigin = requiredArg("--api-origin");
  const contentOrigin = requiredArg("--content-origin");
  const accountId = requiredArg("--account-id");
  return {
    id,
    productName,
    siteOrigin,
    apiOrigin,
    contentOrigin,
    accountId,
  };
}

function ensureDirectory(path: string) {
  mkdirSync(path, { recursive: true });
}

function writeNewFile(path: string, contents: string) {
  if (existsSync(path)) {
    throw new Error(`Refusing to overwrite existing file: ${path}`);
  }
  writeFileSync(path, contents, "utf8");
}

function main() {
  const args = buildArgs();
  const repoRoot = process.cwd();
  const frontendDir = join(repoRoot, "apps", `${args.id}-frontend`);
  const contentDir = join(repoRoot, "apps", `${args.id}-content`);
  const orchestratorDir = join(repoRoot, "apps", `${args.id}-orchestrator`);
  const runtimeDir = join(repoRoot, "apps", `${args.id}-runtime`);

  ensureDirectory(frontendDir);
  ensureDirectory(contentDir);
  ensureDirectory(orchestratorDir);
  ensureDirectory(runtimeDir);

  writeNewFile(join(frontendDir, "package.json"), JSON.stringify({
    name: `@alphabook/${args.id}-frontend`,
    version: "0.1.0",
    private: true,
    type: "module",
    scripts: {
      dev: "vite --config vite.config.ts",
      build: "vite build --config vite.config.ts",
      preview: "vite preview --config vite.config.ts",
      deploy: "npm run build && wrangler deploy",
      typecheck: "tsc -p tsconfig.json --noEmit",
    },
  }, null, 2) + "\n");

  writeNewFile(join(frontendDir, "wrangler.toml"), [
    `name = "${args.id}-web"`,
    'main = "../frontend/src/worker.ts"',
    'compatibility_date = "2026-03-22"',
    `account_id = "${args.accountId}"`,
    "workers_dev = true",
    "upload_source_maps = true",
    "",
    "[observability]",
    "enabled = true",
    "",
    "[assets]",
    'directory = "./dist"',
    'binding = "ASSETS"',
    'not_found_handling = "single-page-application"',
    'html_handling = "auto-trailing-slash"',
    "",
    "[vars]",
    `IMPLEMENTATION_ID = "${args.id}"`,
    `API_ORIGIN = "${args.apiOrigin}"`,
    `SITE_ORIGIN = "${args.siteOrigin}"`,
    `CONTENT_ORIGIN = "${args.contentOrigin}"`,
    "",
    "[[r2_buckets]]",
    'binding = "BOOK_CONTENT_BUCKET"',
    `bucket_name = "${args.id}-corpus"`,
    `preview_bucket_name = "${args.id}-corpus-preview"`,
    "",
  ].join("\n"));

  writeNewFile(join(contentDir, "package.json"), JSON.stringify({
    name: `@alphabook/${args.id}-content`,
    version: "0.1.0",
    private: true,
    type: "module",
    scripts: {
      typecheck: "npm run typecheck -w @alphabook/book-content-worker",
      deploy: "wrangler deploy",
    },
  }, null, 2) + "\n");

  writeNewFile(join(contentDir, "wrangler.toml"), [
    `name = "${args.id}-content"`,
    'main = "../book-content-worker/src/index.ts"',
    'compatibility_date = "2026-03-22"',
    `account_id = "${args.accountId}"`,
    "workers_dev = true",
    "upload_source_maps = true",
    "",
    "[observability]",
    "enabled = true",
    "",
    "[vars]",
    `IMPLEMENTATION_ID = "${args.id}"`,
    `SITE_ORIGIN = "${args.siteOrigin}"`,
    "",
    "[[r2_buckets]]",
    'binding = "BOOK_CONTENT_BUCKET"',
    `bucket_name = "${args.id}-corpus"`,
    `preview_bucket_name = "${args.id}-corpus-preview"`,
    "",
  ].join("\n"));

  writeNewFile(join(orchestratorDir, "package.json"), JSON.stringify({
    name: `@alphabook/${args.id}-orchestrator`,
    version: "0.1.0",
    private: true,
    type: "module",
    scripts: {
      typecheck: "npm run typecheck -w @alphabook/orchestrator-worker",
      deploy: "wrangler deploy",
    },
  }, null, 2) + "\n");

  writeNewFile(join(orchestratorDir, "wrangler.toml"), [
    `name = "${args.id}-orchestrator-api"`,
    'main = "../orchestrator-worker/src/index.ts"',
    'compatibility_date = "2026-03-22"',
    `account_id = "${args.accountId}"`,
    "workers_dev = true",
    "upload_source_maps = true",
    "",
    "[observability]",
    "enabled = true",
    "",
    "[triggers]",
    'crons = ["* * * * *"]',
    "",
    "[vars]",
    `IMPLEMENTATION_ID = "${args.id}"`,
    `SITE_ORIGIN = "${args.siteOrigin}"`,
    `API_ORIGIN = "${args.apiOrigin}"`,
    'OPENAI_MODEL = "gpt-5.2"',
    'OPENAI_SYNTH_MODEL = "gpt-5.2"',
    'OPENAI_EMBEDDING_MODEL = "text-embedding-3-small"',
    'TOOL_STREAM_CLEANUP_MODEL = "@cf/zai-org/glm-4.7-flash"',
    'RUNTIME_AGENT_MODEL = "gpt-5.2-codex"',
    'ORCHESTRATOR_MAX_TURNS = "40"',
    'ORCHESTRATOR_MAX_RUNTIME_TASKS_PER_RUN = "16"',
    'ORCHESTRATOR_MAX_RUN_WALL_CLOCK_SECONDS = "1800"',
    'CHEAP_TOOL_TIMEOUT_SECONDS = "120"',
    'RUNTIME_TOOL_TIMEOUT_SECONDS = "1500"',
    `QUEUE_INGEST_NAME = "${args.id}-ingest"`,
    `QUEUE_JOBS_NAME = "${args.id}-jobs"`,
    `R2_BUCKET_NAME = "${args.id}-corpus"`,
    `RUNTIME_R2_BUCKET_NAME = "${args.id}-corpus"`,
    `FLY_RUNTIME_APP_NAME = "${args.id}-runtime"`,
    `FLY_RUNTIME_APP_URL = "https://${args.id}-runtime.fly.dev"`,
    `FLY_RUNTIME_IMAGE = "registry.fly.io/${args.id}-runtime:initial"`,
    'FLY_RUNTIME_REGION = "iad"',
    'FLY_RUNTIME_MACHINE_CPU_KIND = "shared"',
    'FLY_RUNTIME_MACHINE_CPUS = "2"',
    'FLY_RUNTIME_MACHINE_MEMORY_MB = "4096"',
    "",
    "[[r2_buckets]]",
    'binding = "CORPUS_BUCKET"',
    `bucket_name = "${args.id}-corpus"`,
    `preview_bucket_name = "${args.id}-corpus-preview"`,
    "",
    "[[queues.producers]]",
    'binding = "INGEST_QUEUE"',
    `queue = "${args.id}-ingest"`,
    "",
    "[[queues.producers]]",
    'binding = "JOBS_QUEUE"',
    `queue = "${args.id}-jobs"`,
    "",
    "[ai]",
    'binding = "AI"',
    "",
  ].join("\n"));

  writeNewFile(join(runtimeDir, "fly.toml"), [
    `app = "${args.id}-runtime"`,
    'primary_region = "iad"',
    "",
    "[build]",
    '  dockerfile = "../runtime/Dockerfile"',
    "",
    "[env]",
    '  PORT = "8080"',
    '  RUNTIME_WORKSPACE_ROOT = "/workspace"',
    "",
    "[http_service]",
    '  internal_port = 8080',
    '  force_https = true',
    '  auto_stop_machines = "stop"',
    '  auto_start_machines = true',
    '  min_machines_running = 0',
    "",
    "[vm]",
    '  cpu_kind = "shared"',
    '  cpus = 2',
    '  memory = "4096mb"',
    "",
  ].join("\n"));

  const implementationStub = [
    "Add an implementation entry to packages/implementations/src/index.ts with:",
    `- id: "${args.id}"`,
    `- productName: "${args.productName}"`,
    `- siteOrigin: "${args.siteOrigin}"`,
    `- apiOrigin: "${args.apiOrigin}"`,
    `- contentOrigin: "${args.contentOrigin}"`,
    `- adapterId: "<your-adapter-id>"`,
    "",
    "Provision these resources before deploy:",
    `- R2 bucket: ${args.id}-corpus`,
    `- R2 preview bucket: ${args.id}-corpus-preview`,
    `- Queue: ${args.id}-ingest`,
    `- Queue: ${args.id}-jobs`,
    `- Fly app: ${args.id}-runtime`,
  ].join("\n");

  console.log(`Scaffolded isolated implementation wrappers for "${args.id}".`);
  console.log("");
  console.log(implementationStub);
}

main();
