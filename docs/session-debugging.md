# Debugging Failed Assistant Sessions

Use this runbook when a URL like `https://alpha-book.org/?view=assistant&session=<session-id>` looks broken or a run fails without an obvious answer.

## Fast Path

1. Load the signed-in browser session cookie from [`.dev.vars`](../.dev.vars).

The repo now has a saved helper for this. Prefer it over hand-writing curl:

```bash
npm run debug:session -- --url 'https://alpha-book.org/?view=assistant&session=<session-id>'
```

This script:

- reads `ALPHABOOK_COOKIE` from `.dev.vars`
- uses browser-style headers
- prefers the versioned live API routes under `/api/v1` and falls back only if needed
- resolves the latest run for the session
- calls the admin logs endpoint
- saves the payload to `/tmp/alphabook-run-<run-id>.json`

Use `ALPHABOOK_COOKIE` first. It is the cookie that works most reliably against the live owner/admin endpoints when paired with browser-style headers. Prefer extracting the cookie value instead of `source`-ing the whole file, because `.dev.vars` may contain unquoted values that are not safe to execute as shell.

```bash
COOKIE=$(python3 - <<'PY'
from pathlib import Path
for line in Path('.dev.vars').read_text().splitlines():
    if line.startswith('ALPHABOOK_COOKIE='):
        print(line.split('=', 1)[1].strip().strip('"'))
        break
PY
)
```

This should produce a full cookie string that starts with `alphabook_session=`.

2. Confirm auth works:

```bash
curl -sS 'https://api.alpha-book.org/me' \
  -H "Cookie: $COOKIE" \
  -H 'Origin: https://alpha-book.org' \
  -H 'Referer: https://alpha-book.org/' \
  -H 'User-Agent: Mozilla/5.0' | jq .
```

If this fails, stop there and fix auth first. A healthy response should show `"authenticated": true`.

3. Resolve the run id from the session:

```bash
curl -sS "https://api.alpha-book.org/api/v1/sessions/<session-id>/runs" \
  -H "Cookie: $COOKIE" \
  -H 'Origin: https://alpha-book.org' \
  -H 'Referer: https://alpha-book.org/' \
  -H 'User-Agent: Mozilla/5.0' | jq .
```

4. Fetch the admin payload for the run and save it locally.

The saved script now defaults to the lightweight payload and is the preferred first step. Only opt into the heavy payload when needed.

```bash
npm run debug:session -- --run <run-id>
```

Escalate when needed:

```bash
npm run debug:session -- --run <run-id> --include-artifacts
npm run debug:session -- --run <run-id> --include-artifact-contents
npm run debug:session -- --run <run-id> --include-runtime-instances
npm run debug:session -- --run <run-id> --include-live-runtime
npm run debug:session -- --run <run-id> --full
```

If you need the raw curl manually, use:

```bash
curl -sS "https://api.alpha-book.org/api/v1/admin/runs/<run-id>/logs" \
  -H "Cookie: $COOKIE" \
  -H 'Origin: https://alpha-book.org' \
  -H 'Referer: https://alpha-book.org/' \
  -H 'User-Agent: Mozilla/5.0' \
  -H 'Accept: application/json,text/plain,*/*' \
  > /tmp/alphabook-run-<run-id>.json
```

5. Inspect the top-level size breakdown before doing anything else.

```bash
node - <<'NODE'
const fs = require('fs');
const path = '/tmp/alphabook-run-<run-id>.json';
const data = JSON.parse(fs.readFileSync(path, 'utf8'));
const breakdown = Object.fromEntries(
  Object.entries(data).map(([key, value]) => [key, Buffer.byteLength(JSON.stringify(value))]),
);
console.log(JSON.stringify({
  totalBytes: fs.statSync(path).size,
  breakdown,
}, null, 2));
NODE
```

6. Then inspect the raw tool/runtime failures:

```bash
node - <<'NODE'
const fs = require('fs');
const data = JSON.parse(fs.readFileSync('/tmp/alphabook-run-<run-id>.json', 'utf8'));
const interesting = (data.rawLog || []).filter((entry) => {
  const text = JSON.stringify(entry);
  return /error|failed|unauthorized|timeout|refresh token|codex_core::auth/i.test(text);
});
console.log(JSON.stringify(interesting.slice(-120), null, 2));
NODE
```

This admin payload is the most complete log surface. It includes:

- session
- run
- owner
- messages
- tool calls
- rawLog
- runtime instances
- artifacts
- `liveRuntime`

`liveRuntime` is the important extra field when a run actually reached the Fly runtime or other VM-backed execution path.

## Default Rule

When a user says “check the logs” for a live assistant session:

1. read `ALPHABOOK_COOKIE` from `.dev.vars`
2. confirm `GET /me` works
3. run `npm run debug:session -- --url '<session-url>'`
4. save the full payload locally
5. inspect `rawLog`, `runEvents`, `runtimeInstances`, and `artifacts`

Do not rely only on the summarized run state when the admin payload is available.

## Route Preference

Use the versioned live API routes first:

- `https://api.alpha-book.org/api/v1/...`
- `https://api.alpha-book.org/v1/...`

Do not start with unversioned live routes such as `/admin/runs` or `/sessions/:id/runs` when debugging production sessions. Those paths may be routed to the SPA shell and return HTML with `200 OK` instead of JSON.

## Detailed Endpoints

- `GET /api/v1/sessions/:sessionId/debug`
  Best whole-session debug snapshot for a signed-in owner.
- `GET /api/v1/sessions/:sessionId/runs/:runId/debug`
  Best structured per-run snapshot.
- `GET /api/v1/sessions/:sessionId/runs/:runId/logs`
  Best per-run artifact view for non-admin debugging.
- `GET /api/v1/admin/runs/:runId/logs`
  Best overall log endpoint. Use this first when admin access is available.

## Why Can The Admin Payload Be Huge?

It is not pulling old runs. It is usually huge because the endpoint currently inlines large per-run payloads:

- `artifacts`
  This includes full `content` for stored runtime artifacts. For sprite runs, that often means one large `manifest.json` per shard.
- `runtimeInstances`
  This includes full `manifestJson` for every runtime instance, and each sprite shard manifest can contain roughly 1,000 works.

In one real sprite run, the size breakdown was approximately:

- `artifacts`: ~46.7 MB
- `runtimeInstances`: ~28.3 MB
- `rawLog`: ~0.17 MB
- `runEvents`: ~0.16 MB

So the payload was about 75 MB because it was repeating the shard manifests twice:

- once in `runtimeInstances[*].manifestJson`
- again in `artifacts[*].content` for the persisted `manifest.json` files

This means the endpoint is useful, but currently too heavy for routine inspection without saving the payload locally first.

## What To Look At First In A Big Payload

For live failure diagnosis, prioritize these fields:

- `rawLog`
  Best source for exact runtime/model/tool stderr-style lines.
- `runEvents`
  Best source for lifecycle ordering.
- `toolCalls`
  Best source for parent tool status.
- `liveRuntime`
  Best source for currently running runtime file snapshots.

Only inspect `artifacts` and `runtimeInstances` deeply if you need:

- stored file contents
- per-runtime manifests
- exact workspace composition

They are usually the fields causing the payload explosion.

## How To Read The Failure

- If `messages` or `runs` return `403`, the problem is session access or browser auth.
- If the run has `plannerTurns: 0` and `toolCalls: []`, the failure happened before any retrieval or runtime tool work started.
- The most useful field is usually the `run.completed.payload.error` entry inside the raw `tool_stream_raw` artifact in the run logs response.
- If the run reached VM-backed execution, check `liveRuntime` from the admin logs endpoint for runtime-specific failures and file snapshots.

## Common Failure Buckets

- Auth/session issue:
  `GET /me` fails, or session endpoints return `403`.
- Router/planner upstream issue:
  run fails before any tool starts.
- Retrieval/runtime issue:
  tool calls exist, but one of them ends in `failed` or `timed_out`.
- UI-only issue:
  API responses are healthy, but the page still renders incorrectly.

## Do The Detailed Endpoints Show The Exact Error?

Usually yes, but not always in the top-level `run.status` field.

Where to look:

- `toolCalls`
  Good for tool-level failures after planning has started.
- `artifacts`
  Often includes `tool_stream_raw`, briefings, notes, or recovered traces.
- `tool_stream_raw`
  Often contains the clearest serialized `run.completed` error payload.
- `rawLog`
  Now exposes the parsed chronological audit stream directly in the JSON response, including internal helper/model steps such as title generation, log cleanup, router, planner, embedding, and synthesis events.
- `liveRuntime`
  Best source for VM/runtime-side failures when runtime work actually started.

Limits:

- If the failure happens before planning or tool execution, there may be no `toolCalls` and no `runtimeInstances`.
- In those cases, the raw stream artifact is often the only place where the underlying upstream error is preserved.

## Session `c5317ca2-a7ef-40e0-8247-2b06b608f3d2`

This session failed at the router call before planning started.

Facts:

- `runId`: `b113d4ee-9f71-41f0-b156-99b431afd69e`
- `status`: `failed`
- `plannerTurns`: `0`
- `toolCalls`: `[]`

Root cause from the raw run log:

```text
Router request failed:
{
  "error": {
    "message": "You exceeded your current quota, please check your plan and billing details.",
    "type": "insufficient_quota",
    "code": "insufficient_quota"
  }
}
```

So the issue was not session access, retrieval, or runtime execution. The worker's first OpenAI router call failed because the configured OpenAI account had no remaining quota.
