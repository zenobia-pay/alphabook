# DigitalOcean Linux Deployment

This directory contains the Linux-native AlphaBook deployment scaffolding for the staged migration onto generic Linux infrastructure.

Current production hosts:

- `alphabook-web-01` -> `178.128.159.197`
- `alphabook-worker-01` -> `143.198.162.219`

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

## Production deploy

Primary live deploy command:

```bash
npm run deploy:prod
```

That deploys the current production surface in order:

1. static frontend bundle to `alphabook-web-01`
2. Linux API containers to `alphabook-web-01`
3. Linux worker/runtime containers to `alphabook-worker-01`

Do not use Cloudflare Worker deploys for the primary AlphaBook web or API path.

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
  Worker maintenance interval. This no longer re-dispatches queued tasks or auto-fails stale runs.
- `QUEUE_JOBS_NAME`

Web-specific:

- `SITE_ORIGIN`
- `API_ORIGIN`
- `WORKOS_API_KEY`
- `WORKOS_CLIENT_ID`
- `AUTH_COOKIE_PASSWORD`

## Notes

- The main AlphaBook web and API path is Linux-native behind proxied Cloudflare DNS. Do not deploy the primary AlphaBook session UI or API through Cloudflare Workers.
- The Linux API path is Postgres-only. It does not fall back to D1 or Wrangler.
- Canonical blobs are expected to live in DO Spaces or another S3-compatible object store.
- The Linux worker uses `pg-boss` for durable research task execution.
- The Linux worker expects a normal HTTP runtime service on the private network. It does not launch Fly Machines.
- `books.alpha-book.org` is still the one remaining Cloudflare Worker-backed surface; it is not part of the main app/API deploy path.
