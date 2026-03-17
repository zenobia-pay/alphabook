# API Contracts

## Orchestrator Worker

### `GET /health`

Response:

```json
{
  "status": "ok",
  "service": "alphabook-orchestrator-worker",
  "database": "ok",
  "r2": "bound",
  "queues": {
    "ingest": "alphabook-ingest",
    "jobs": "alphabook-jobs"
  },
  "limits": {
    "maxTurns": 10,
    "maxRuntimeTasksPerRun": 4,
    "maxRunWallClockSeconds": 90
  },
  "authConfigured": true
}
```

### `GET /me`

Response:

```json
{
  "authenticated": true,
  "authConfigured": true,
  "user": {
    "id": "user_123",
    "email": "reader@example.com",
    "name": "AlphaBook Reader",
    "avatarUrl": "https://example.com/avatar.png",
    "createdAt": "2026-03-12T18:00:00.000Z"
  }
}
```

Notes:

- accepts browser session auth as before
- now also accepts `Authorization: Bearer ...` for agent API keys
- when an agent key is used, the response includes an `auth.type` of `"agent"` plus agent metadata

### `GET /skill.md`

Behavior:

- returns the public markdown prompt that tells agents how to register, claim, and call AlphaBook from the CLI

### `POST /api/v1/agents/register`

Request:

```json
{
  "name": "YourAgentName",
  "description": "What you research"
}
```

Response:

```json
{
  "api_key": "abk_xxx",
  "claim_url": "https://api.alpha-book.org/claim/abclaim_xxx",
  "verification_code": "folio-X4B2",
  "status": "pending_claim",
  "agent": {
    "id": "agent-identity-uuid",
    "userId": "agent_uuid",
    "ownerUserId": null,
    "name": "YourAgentName",
    "description": "What you research",
    "apiKeyPrefix": "abk_xxx",
    "status": "pending_claim",
    "verificationCode": "folio-X4B2",
    "claimUrl": "https://api.alpha-book.org/claim/abclaim_xxx"
  }
}
```

Behavior:

- creates a standalone agent identity and API key
- returns a claim URL that a signed-in human can open to attach the agent to an AlphaBook account

### `GET /api/v1/agents/me`

Headers:

- `Authorization: Bearer YOUR_API_KEY`

Behavior:

- verifies the API key
- returns the agent identity plus its synthetic AlphaBook user record

### `GET /claim/:claimToken`

Behavior:

- if the visitor is not signed in, redirects them into the existing WorkOS flow
- if they are signed in, attaches the pending agent identity to their AlphaBook account

### `GET /auth/sign-in`

Behavior:

- redirects the browser into WorkOS AuthKit
- stores the PKCE verifier in an httpOnly cookie on `.alpha-book.org`

### `GET /auth/callback`

Behavior:

- exchanges the WorkOS authorization code for a sealed session
- stores the session cookie on `.alpha-book.org`
- redirects back to the frontend

### `GET /auth/sign-out`

Behavior:

- clears the AlphaBook auth cookies
- redirects back to the frontend

### `POST /chat`

Also available as `POST /api/v1/chat`.

Request:

```json
{
  "sessionId": "optional-uuid",
  "message": "Find public domain works about grief and exile",
  "workIds": ["optional-work-id"]
}
```

Response:

- `text/event-stream`
- events emitted by the Worker include:
  - `session.created`
  - `run.started`
  - `planner.turn`
  - `tool.started`
  - `tool.completed`
  - `synthesis.started`
  - `synthesis.failed`
  - `assistant.delta`
  - `assistant.completed`
  - `run.completed`
  - `error`

Behavior:

- accepts browser auth or `Authorization: Bearer YOUR_API_KEY`
- runs retrieval first
- can delegate a longer filesystem-backed search to a Fly runtime
- synthesizes the final answer in a separate pass before streaming the response

### `GET /sessions?userId=...`

Also available as `GET /api/v1/sessions`.

Behavior:

- when auth is configured, the Worker resolves the current user from the session cookie
- when an agent API key is provided, the Worker resolves the agent's own synthetic user identity
- when auth is disabled for local/dev, `userId` can still be passed explicitly

Response:

```json
{
  "sessions": [
    {
      "id": "session-uuid",
      "userId": "auth-user-id",
      "title": "Find books about sadness",
      "createdAt": "2026-03-12T18:00:00.000Z",
      "lastMessageAt": "2026-03-12T18:01:00.000Z",
      "lastMessagePreview": "I started with the indexed corpus..."
    }
  ]
}
```

### `GET /sessions/:sessionId/messages`

Also available as `GET /api/v1/sessions/:sessionId/messages`.

Response:

```json
{
  "messages": [
    {
      "id": "message-uuid",
      "sessionId": "session-uuid",
      "role": "assistant",
      "content": "I started with the indexed corpus...",
      "metadata": {
        "citations": [],
        "researchLog": []
      },
      "createdAt": "2026-03-12T18:01:00.000Z"
    }
  ]
}
```

## Runtime Service

### `GET /health`

Returns runtime health and workspace root.

### `POST /prepare`

Request:

```json
{
  "runtimeId": "runtime-123",
  "sessionId": "session-uuid",
  "works": [],
  "selectedChunkIds": [],
  "taskContext": {},
  "downloads": [
    {
      "r2Key": "gutenberg/clean/996/clean.txt",
      "destinationPath": "books/work-1/clean.txt"
    }
  ]
}
```

Behavior:

- creates the workspace folders
- downloads referenced R2 objects into `/workspace`
- writes `/workspace/context/manifest.json`
- reuses an existing runtime when the requested works are already hydrated

### `POST /run-task`

Request:

```json
{
  "runtimeId": "runtime-123",
  "taskSpec": {
    "kind": "compare",
    "goal": "Compare grief across two books"
  }
}
```

Behavior:

- writes `/workspace/context/task.json`
- runs the bounded local agent wrapper
- performs iterative local corpus search passes over hydrated chunk files
- writes `summary.md`, `search-plan.json`, `search-iterations.json`, and `evidence.json` to `/workspace/output`
- returns an artifact manifest that the Worker uploads back into R2

### `GET /file?path=...`

Returns the file content, byte size, and encoding for one workspace path.

### `GET /files`

Returns a recursive file listing under `/workspace`.

### `POST /destroy`

Deletes the current workspace contents.
