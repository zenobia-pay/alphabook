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
