# Debugging Failed Assistant Sessions

Use this runbook when a URL like `https://alpha-book.org/?view=assistant&session=<session-id>` looks broken or a run fails without an obvious answer.

## Fast Path

1. Load the signed-in session cookie from [`.dev.vars`](/Users/ryanprendergast/Documents/Zenobia%20Pay/alphabook/.dev.vars).

Prefer extracting just `ALPHABOOK_API_SESSION_COOKIE` instead of `source`-ing the whole file, because `.dev.vars` may contain unquoted values that are not safe to execute as shell.

```bash
COOKIE=$(python3 - <<'PY'
from pathlib import Path
for line in Path('.dev.vars').read_text().splitlines():
    if line.startswith('ALPHABOOK_API_SESSION_COOKIE='):
        print(line.split('=', 1)[1].strip().strip('"'))
        break
PY
)
```

This should produce a full cookie string that starts with `alphabook_session=`.

2. Confirm auth works:

```bash
curl -sS 'https://api.alpha-book.org/me' -H "Cookie: $COOKIE" | jq .
```

If this fails, stop there and fix auth first. A healthy response should show `"authenticated": true`.

3. Fetch the session transcript:

```bash
curl -sS "https://api.alpha-book.org/sessions/<session-id>/messages" -H "Cookie: $COOKIE" | jq .
```

4. Fetch session runs:

```bash
curl -sS "https://api.alpha-book.org/sessions/<session-id>/runs" -H "Cookie: $COOKIE" | jq .
```

5. Inspect the failed run:

```bash
curl -sS "https://api.alpha-book.org/sessions/<session-id>/runs/<run-id>/logs" -H "Cookie: $COOKIE" | jq .
```

6. If you are an admin, prefer the richer admin log view:

```bash
curl -sS "https://api.alpha-book.org/admin/runs/<run-id>/logs" -H "Cookie: $COOKIE" | jq .
```

This is the most complete log surface. It includes:

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

## Detailed Endpoints

- `GET /sessions/:sessionId/debug`
  Best whole-session debug snapshot for a signed-in owner.
- `GET /sessions/:sessionId/runs/:runId/debug`
  Best structured per-run snapshot.
- `GET /sessions/:sessionId/runs/:runId/logs`
  Best per-run artifact view for non-admin debugging.
- `GET /admin/runs/:runId/logs`
  Best overall log endpoint. Use this first when admin access is available.

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
