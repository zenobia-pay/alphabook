# Debugging Failed Assistant Sessions

Use this runbook when a URL like `https://alpha-book.org/?view=assistant&session=<session-id>` looks broken or a run fails without an obvious answer.

## Fast Path

1. Confirm auth works:

```bash
COOKIE='alphabook_session=...'
curl -sS 'https://api.alpha-book.org/me' -H "Cookie: $COOKIE" | jq .
```

If this fails, stop there and fix auth first. A healthy response should show `"authenticated": true`.

2. Fetch the session transcript:

```bash
curl -sS "https://api.alpha-book.org/sessions/<session-id>/messages" -H "Cookie: $COOKIE" | jq .
```

3. Fetch session runs:

```bash
curl -sS "https://api.alpha-book.org/sessions/<session-id>/runs" -H "Cookie: $COOKIE" | jq .
```

4. Inspect the failed run:

```bash
curl -sS "https://api.alpha-book.org/sessions/<session-id>/runs/<run-id>/logs" -H "Cookie: $COOKIE" | jq .
```

## How To Read The Failure

- If `messages` or `runs` return `403`, the problem is session access or browser auth.
- If the run has `plannerTurns: 0` and `toolCalls: []`, the failure happened before any retrieval or runtime tool work started.
- The most useful field is usually the `run.completed.payload.error` entry inside the raw `tool_stream_raw` artifact in the run logs response.

## Common Failure Buckets

- Auth/session issue:
  `GET /me` fails, or session endpoints return `403`.
- Router/planner upstream issue:
  run fails before any tool starts.
- Retrieval/runtime issue:
  tool calls exist, but one of them ends in `failed` or `timed_out`.
- UI-only issue:
  API responses are healthy, but the page still renders incorrectly.

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
