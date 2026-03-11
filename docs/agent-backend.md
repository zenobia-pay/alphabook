# Agent Backend

The `fast` path can stay inside Cloudflare Workers because it only does embeddings-style routing and plain-text ranking.

The `agent` path cannot.

Workers do not provide a runtime for spawning local CLI tools like `codex exec`, so the slow path needs a separate service. The implementation in this repo uses a small FastAPI server that:

1. receives a job from the Worker
2. runs `alphabook` orchestration in the background
3. prefers the Codex CLI runner when `ALPHABOOK_ENABLE_CODEX_RUNNER=1`
4. falls back to Terminal Use or the local deep scan runner
5. exposes job status for the Worker to poll

## Recommended shape

- Public surface: Cloudflare Worker
- Slow agent runtime: VM, container, or private server
- Auth between them: shared bearer token
- Worker env:
  - `AGENT_BACKEND_URL`
  - `AGENT_BACKEND_TOKEN` optional but recommended
- Agent server env:
  - `ALPHABOOK_ENABLE_CODEX_RUNNER=1`
  - `ALPHABOOK_AGENT_API_TOKEN` if you want bearer auth
  - `OPENAI_API_KEY` if your Codex or embedding path needs it

## Local start

```bash
source .venv/bin/activate
export ALPHABOOK_ENABLE_CODEX_RUNNER=1
alphabook-agent-server --host 127.0.0.1 --port 9001
```

## Worker integration

When `AGENT_BACKEND_URL` is present, the Worker assistant exposes two modes:

- `Fast`: immediate answer from the bundled retrieval stack
- `Agent`: enqueue a background job on the external server

The Worker stores the pending assistant message, then replaces it with the finished result once the backend job reports `completed` or `failed`.
