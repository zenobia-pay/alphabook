# DigitalOcean Linux Deployment

This directory contains the first Linux-native AlphaBook deployment scaffolding for the staged migration off Cloudflare application infrastructure.

Target boxes:

- `do-web-01`
  - `caddy`
  - `alphabook-api`
- `do-worker-01`
  - `alphabook-worker`
  - `alphabook-runtime`
- `do-db-01`
  - `postgres`
  - optional `redis`

Keep the existing Gutenberg mirror and Qdrant droplets in place. Point the worker/API boxes at those existing services.

## Bootstrap sequence

1. Copy the relevant compose bundle onto each droplet.
2. Fill in the matching `.env` file from the examples in this directory.
3. Start Postgres first.
4. Run `DATABASE_URL=... npm run migrate`.
5. Start `do-worker-01`.
6. Start `do-web-01`.
7. Put Cloudflare in front of the web box and restrict origin access to Cloudflare IP ranges.

## Compose bundles

- `db/docker-compose.yml`
- `worker/docker-compose.yml`
- `web/docker-compose.yml`

## Required Linux env

Shared:

- `DATABASE_URL`
- `OPENAI_API_KEY`
- `OPENAI_MODEL`
- `OPENAI_SYNTH_MODEL`
- `SPACES_BUCKET_NAME`
- `SPACES_ENDPOINT`
- `SPACES_ACCESS_KEY_ID`
- `SPACES_SECRET_ACCESS_KEY`
- `QDRANT_URL`
- `QDRANT_COLLECTION`
- `RUNTIME_SERVICE_URL`
- `RUNTIME_SERVICE_TOKEN`

Worker-specific:

- `JANITOR_INTERVAL_MS`
- `QUEUE_JOBS_NAME`

Web-specific:

- `SITE_ORIGIN`
- `API_ORIGIN`
- `WORKOS_API_KEY`
- `WORKOS_CLIENT_ID`
- `AUTH_COOKIE_PASSWORD`

## Notes

- The Linux API path uses `DATABASE_URL` when present and falls back to D1 only for local compatibility.
- Canonical blobs are expected to live in DO Spaces via the S3-compatible blob store.
- The Linux worker uses `pg-boss` for durable research task execution.
