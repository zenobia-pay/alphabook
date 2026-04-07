# Environment Variables

For any new implementation, do not reuse another implementation's storage bucket, queue, runtime service, or content origin in committed config. Use implementation-scoped names such as `<implementation-id>-corpus`, `<implementation-id>-ingest`, `<implementation-id>-jobs`, and `<implementation-id>-runtime`.

## Frontend

- `VITE_API_BASE_URL`

## Linux API / Worker

- `DATABASE_URL`
- `OPENAI_API_KEY`
- `OPENAI_MODEL`
- `OPENAI_SYNTH_MODEL`
- `OPENAI_EMBEDDING_MODEL`
- `TOOL_STREAM_CLEANUP_MODEL`
- `RUNTIME_SERVICE_URL`
- `RUNTIME_SERVICE_TOKEN`
- `QUEUE_INGEST_NAME`
- `QUEUE_JOBS_NAME`
- `S3_BUCKET_NAME` or `SPACES_BUCKET_NAME`
- `S3_ENDPOINT` or `SPACES_ENDPOINT`
- `S3_ACCESS_KEY_ID` or `SPACES_ACCESS_KEY_ID`
- `S3_SECRET_ACCESS_KEY` or `SPACES_SECRET_ACCESS_KEY`
- `S3_REGION` or `SPACES_REGION`
- `WORKOS_API_KEY`
- `WORKOS_CLIENT_ID`
- `AUTH_COOKIE_PASSWORD`
- `ERROR_ALERT_WEBHOOK_URL`

## Runtime Service

- `PORT`
- `RUNTIME_WORKSPACE_ROOT`
- `RUNTIME_AGENT_COMMAND`
- `RUNTIME_SHARED_TOKEN`
- `S3_BUCKET_NAME` or `SPACES_BUCKET_NAME`
- `S3_ENDPOINT` or `SPACES_ENDPOINT`
- `S3_ACCESS_KEY_ID` or `SPACES_ACCESS_KEY_ID`
- `S3_SECRET_ACCESS_KEY` or `SPACES_SECRET_ACCESS_KEY`
- `S3_REGION` or `SPACES_REGION`

`ERROR_ALERT_WEBHOOK_URL` sends unexpected orchestrator errors to a webhook in addition to recording them in the admin incident dashboard. Leave it unset if you only want the in-app admin view.

## Ingest Service

- `DATABASE_URL`
- `S3_BUCKET_NAME` or `SPACES_BUCKET_NAME`
- `S3_ENDPOINT` or `SPACES_ENDPOINT`
- `S3_ACCESS_KEY_ID` or `SPACES_ACCESS_KEY_ID`
- `S3_SECRET_ACCESS_KEY` or `SPACES_SECRET_ACCESS_KEY`
- `S3_REGION` or `SPACES_REGION`
- `COURTLISTENER_API_TOKEN`
- `GUTENBERG_MIRROR_ROOT`
- `GUTENBERG_METADATA_FEED_URL`
- `OPENAI_API_KEY`
- `OPENAI_EMBEDDING_MODEL`
- `MIRROR_BATCH_SIZE`
- `MIRROR_CHECKPOINT_PATH`
- `BOOK_HTML_BATCH_SIZE`
- `SUPREME_COURT_BATCH_SIZE`

## DigitalOcean Gutenberg Mirror Box

- `ALPHABOOK_ROOT`
- `GUTENBERG_MIRROR_ROOT`
- `PG_RSYNC_HOST`
- `RSYNC_TIMEOUT`

## Shared Operational Limits

- `MAX_TURNS`
- `MAX_RUNTIME_TASKS_PER_RUN`
- `MAX_WORKSPACE_BYTES`
- `MAX_RUNTIME_IDLE_MINUTES`
- `MAX_RUN_WALL_CLOCK_SECONDS`
- `MAX_TOOL_TIMEOUT_SECONDS`
