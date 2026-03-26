# Repository Instructions

## Session Debugging

- When given an AlphaBook session or run link to debug, use the workflow in [docs/session-debugging.md](/Users/ryanprendergast/Documents/Zenobia%20Pay/alphabook/docs/session-debugging.md).
- Prefer the saved helper: `npm run debug:session -- --url '<session-url>'`.
- Use `ALPHABOOK_COOKIE` from `.dev.vars` and call the admin run logs endpoint first.
- Start with the default lightweight payload and only opt into `includeArtifacts`, `includeArtifactContents`, `includeRuntimeInstances`, or `includeLiveRuntime` when needed.
