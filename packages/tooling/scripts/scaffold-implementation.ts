import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

type Args = {
  id: string;
  productName: string;
  siteOrigin: string;
  apiOrigin: string;
  contentOrigin: string;
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
  return {
    id,
    productName,
    siteOrigin: requiredArg("--site-origin"),
    apiOrigin: requiredArg("--api-origin"),
    contentOrigin: requiredArg("--content-origin"),
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
  const deploymentDir = join(repoRoot, "apps", `${args.id}-deployment`);
  const runtimeDir = join(repoRoot, "apps", `${args.id}-runtime`);

  ensureDirectory(frontendDir);
  ensureDirectory(deploymentDir);
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
      typecheck: "tsc -p tsconfig.json --noEmit",
    },
  }, null, 2) + "\n");

  writeNewFile(join(frontendDir, "tsconfig.json"), JSON.stringify({
    extends: "../frontend/tsconfig.json",
    include: ["vite.config.ts"],
  }, null, 2) + "\n");

  writeNewFile(join(frontendDir, "vite.config.ts"), `import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import path from "node:path";

const sharedFrontendRoot = path.resolve(__dirname, "../frontend");

export default defineConfig({
  root: sharedFrontendRoot,
  envDir: __dirname,
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      "@": path.resolve(sharedFrontendRoot, "./src"),
    },
  },
  build: {
    outDir: path.resolve(__dirname, "./dist"),
    emptyOutDir: true,
  },
  server: {
    host: "127.0.0.1",
    port: 4293,
    proxy: {
      "/api": {
        target: "http://127.0.0.1:8787",
        changeOrigin: true,
        rewrite: (value) => value.replace(/^\\/api/, ""),
      },
    },
  },
  preview: {
    host: "127.0.0.1",
    port: 4293,
  },
});
`);

  writeNewFile(join(frontendDir, ".env.example"), `VITE_IMPLEMENTATION_ID=${args.id}
VITE_API_BASE_URL=${args.apiOrigin}
VITE_PRODUCT_NAME=${args.productName}
VITE_DEFAULT_READER_NAME=${args.productName} Reader
VITE_SITE_NAME=${args.productName}
VITE_SITE_ORIGIN=${args.siteOrigin}
VITE_CONTENT_ORIGIN=${args.contentOrigin}
VITE_SITE_DESCRIPTION=Grounded research over your corpus.
VITE_THEME_COLOR=#eef2f7
VITE_OG_IMAGE_URL=${args.siteOrigin}/social-card.svg
`);

  writeNewFile(join(deploymentDir, ".env.api.example"), `IMPLEMENTATION_ID=${args.id}
SITE_ORIGIN=${args.siteOrigin}
API_ORIGIN=${args.apiOrigin}
CONTENT_ORIGIN=${args.contentOrigin}
DATABASE_URL=postgres://postgres:postgres@127.0.0.1:5432/${args.id}
OPENAI_API_KEY=
OPENAI_MODEL=gpt-5.2
OPENAI_SYNTH_MODEL=gpt-5.2
OPENAI_EMBEDDING_MODEL=text-embedding-3-small
QUEUE_INGEST_NAME=${args.id}-ingest
QUEUE_JOBS_NAME=${args.id}-jobs
S3_BUCKET_NAME=${args.id}-corpus
S3_ENDPOINT=https://nyc3.digitaloceanspaces.com
S3_ACCESS_KEY_ID=
S3_SECRET_ACCESS_KEY=
S3_REGION=us-east-1
RUNTIME_SERVICE_URL=http://10.0.0.12:8080
RUNTIME_SERVICE_TOKEN=
`);

  writeNewFile(join(deploymentDir, ".env.runtime.example"), `PORT=8080
RUNTIME_WORKSPACE_ROOT=/workspace
RUNTIME_AGENT_COMMAND=codex
RUNTIME_SHARED_TOKEN=
S3_BUCKET_NAME=${args.id}-corpus
S3_ENDPOINT=https://nyc3.digitaloceanspaces.com
S3_ACCESS_KEY_ID=
S3_SECRET_ACCESS_KEY=
S3_REGION=us-east-1
`);

  writeNewFile(join(deploymentDir, "README.md"), `# ${args.productName} Linux Deployment

This scaffold is Linux-first. It does not generate Cloudflare Workers, R2 buckets, or Fly runtimes.

Create:

- a frontend wrapper in \`apps/${args.id}-frontend\`
- a Linux API env file in \`apps/${args.id}-deployment/.env.api.example\`
- a Linux runtime env file in \`apps/${args.id}-deployment/.env.runtime.example\`

Expected infra:

- Postgres database
- S3-compatible object storage bucket
- queue names backed by Postgres and \`pg-boss\`
- private runtime service
- reverse proxy in front of the shared frontend build and API
`);

  writeNewFile(join(runtimeDir, "README.md"), `# ${args.productName} Runtime

Point the shared runtime service at this implementation by setting:

- \`IMPLEMENTATION_ID=${args.id}\`
- the matching object storage bucket
- the runtime shared token
`);

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
    `- Postgres database: ${args.id}`,
    `- Object storage bucket: ${args.id}-corpus`,
    `- Queue name: ${args.id}-ingest`,
    `- Queue name: ${args.id}-jobs`,
    `- Runtime service: ${args.id}-runtime`,
  ].join("\n");

  console.log(`Scaffolded Linux-first implementation files for "${args.id}".`);
  console.log("");
  console.log(implementationStub);
}

main();
