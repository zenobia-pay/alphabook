# Repository Instructions

## Session Debugging

- When given an AlphaBook session or run link to debug, use the workflow in [docs/session-debugging.md](/Users/ryanprendergast/Documents/Zenobia%20Pay/alphabook/docs/session-debugging.md).
- Prefer the saved helper: `npm run debug:session -- --url '<session-url>'`.
- Use `ALPHABOOK_COOKIE` from `.dev.vars` and call the admin run logs endpoint first.
- Start with the default lightweight payload and only opt into `includeArtifacts`, `includeArtifactContents`, `includeRuntimeInstances`, or `includeLiveRuntime` when needed.

## Runtime Image Pin

- The comprehensive sprite path launches Fly runtime VMs using `FLY_RUNTIME_IMAGE` from [apps/orchestrator-worker/wrangler.toml](/Users/ryanprendergast/Documents/Zenobia%20Pay/alphabook/apps/orchestrator-worker/wrangler.toml).
- Before any orchestrator deploy, sync that pin to the latest `alphabook-runtime` Fly release image.
- Prefer the built-in deploy path: `npm --workspace @alphabook/orchestrator-worker run deploy`. It now refreshes the runtime image pin before running `wrangler deploy`.

## DigitalOcean Mirror Workflow

- The primary Gutenberg rsync box is currently reachable as `root@134.209.116.167`.
- The box layout is:
  - `/srv/alphabook/.ingest.env`
  - `/srv/alphabook/gutenberg`
  - `/srv/alphabook/bin`
  - `/srv/alphabook/repo`
- The repo on that box may contain project files without a usable `.git` checkout. If a targeted ops fix is needed, copy the changed files over with `scp` instead of assuming `git pull` will work.
- For corpus cutover/rebuild work on the droplet:
  - freeze recurring timers first with `sudo /srv/alphabook/bin/freeze-gutenberg-ingest.sh`
  - audit with `sudo /srv/alphabook/bin/audit-cloudflare-corpus.sh`
  - rebuild D1 + Vectorize with `sudo /srv/alphabook/bin/rebuild-r2-corpus-all.sh`
  - regenerate static pages with `sudo /srv/alphabook/bin/rebuild-book-html-all.sh`
  - validate with `sudo /srv/alphabook/bin/validate-corpus-integrity.sh`
  - prune only after reviewing dry-run reports:
    - `sudo APPLY_FLAG=--apply /srv/alphabook/bin/prune-orphan-vectors.sh`
    - `sudo APPLY_FLAG=--apply /srv/alphabook/bin/prune-orphan-d1-records.sh`
    - `sudo APPLY_FLAG=--apply /srv/alphabook/bin/prune-orphan-r2-keys.sh`
  - resume timers with `sudo /srv/alphabook/bin/resume-gutenberg-ingest.sh`
- For a targeted static-book rebuild on a single Gutenberg ID `N`, use:
  - `npx tsx apps/ingest/src/index.ts rebuild-book-html $((N-1)) 1 1`
  - Example for Gutenberg `18`: `npx tsx apps/ingest/src/index.ts rebuild-book-html 17 1 1`
- For local one-off `rebuild-book-html` runs from this repo:
  - `apps/ingest/src/index.ts` auto-loads `.dev.vars`
  - local `.dev.vars` may contain quoted R2 credentials and a stale Cloudflare API token that breaks Wrangler D1 auth
  - prefer Wrangler OAuth login on the machine and do not rely on `CLOUDFLARE_API_TOKEN`
  - for Vectorize operations, use Wrangler OAuth via `npx wrangler vectorize ... --config apps/orchestrator-worker/wrangler.toml`; do not build new REST-token codepaths when Wrangler already supports the operation
  - if needed, temporarily move `.dev.vars` out of the way and export only normalized `R2_*` plus embedding vars before running the ingest CLI
