export const MIGRATIONS = [
  {
    id: "0001_initial",
    sql: `
CREATE EXTENSION IF NOT EXISTS vector;

CREATE TABLE IF NOT EXISTS users (
  id text PRIMARY KEY,
  email text UNIQUE,
  name text,
  avatar_url text,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS chat_sessions (
  id uuid PRIMARY KEY,
  user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  title text,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS messages (
  id uuid PRIMARY KEY,
  session_id uuid NOT NULL REFERENCES chat_sessions(id) ON DELETE CASCADE,
  role text NOT NULL CHECK (role IN ('user', 'assistant', 'system', 'tool')),
  content text NOT NULL,
  metadata_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS runs (
  id uuid PRIMARY KEY,
  session_id uuid NOT NULL REFERENCES chat_sessions(id) ON DELETE CASCADE,
  status text NOT NULL CHECK (status IN ('queued', 'running', 'completed', 'failed', 'timed_out')),
  started_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  planner_turns integer NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS tool_calls (
  id uuid PRIMARY KEY,
  run_id uuid NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  tool_name text NOT NULL,
  args_json jsonb NOT NULL,
  result_json jsonb,
  started_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  status text NOT NULL CHECK (status IN ('queued', 'running', 'completed', 'failed', 'timed_out'))
);

CREATE TABLE IF NOT EXISTS authors (
  id uuid PRIMARY KEY,
  name text NOT NULL,
  sort_name text,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS works (
  id uuid PRIMARY KEY,
  gutenberg_id bigint UNIQUE,
  title text NOT NULL,
  language text,
  release_date date,
  rights_status text,
  summary text,
  metadata_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS work_authors (
  work_id uuid NOT NULL REFERENCES works(id) ON DELETE CASCADE,
  author_id uuid NOT NULL REFERENCES authors(id) ON DELETE CASCADE,
  PRIMARY KEY (work_id, author_id)
);

CREATE TABLE IF NOT EXISTS subjects (
  id uuid PRIMARY KEY,
  label text NOT NULL UNIQUE
);

CREATE TABLE IF NOT EXISTS work_subjects (
  work_id uuid NOT NULL REFERENCES works(id) ON DELETE CASCADE,
  subject_id uuid NOT NULL REFERENCES subjects(id) ON DELETE CASCADE,
  PRIMARY KEY (work_id, subject_id)
);

CREATE TABLE IF NOT EXISTS work_files (
  id uuid PRIMARY KEY,
  work_id uuid NOT NULL REFERENCES works(id) ON DELETE CASCADE,
  kind text NOT NULL CHECK (kind IN ('raw', 'metadata', 'clean', 'chunks', 'book_html')),
  r2_key text NOT NULL UNIQUE,
  byte_size bigint,
  sha256 text,
  metadata_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS chunks (
  id uuid PRIMARY KEY,
  work_id uuid NOT NULL REFERENCES works(id) ON DELETE CASCADE,
  chunk_index integer NOT NULL,
  text text NOT NULL,
  embedding vector(1536),
  tsv tsvector,
  r2_key text,
  metadata_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (work_id, chunk_index)
);

CREATE TABLE IF NOT EXISTS runtime_instances (
  id uuid PRIMARY KEY,
  session_id uuid NOT NULL REFERENCES chat_sessions(id) ON DELETE CASCADE,
  runtime_id text NOT NULL UNIQUE,
  provider text NOT NULL,
  provider_machine_id text,
  status text NOT NULL CHECK (status IN ('creating', 'ready', 'busy', 'destroyed', 'failed', 'expired')),
  manifest_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  last_used_at timestamptz,
  expires_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS artifacts (
  id uuid PRIMARY KEY,
  session_id uuid NOT NULL REFERENCES chat_sessions(id) ON DELETE CASCADE,
  runtime_id text,
  r2_key text NOT NULL UNIQUE,
  filename text NOT NULL,
  mime_type text NOT NULL,
  metadata_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS jobs (
  id uuid PRIMARY KEY,
  type text NOT NULL,
  payload_json jsonb NOT NULL,
  status text NOT NULL CHECK (status IN ('queued', 'running', 'completed', 'failed')),
  attempts integer NOT NULL DEFAULT 0,
  run_after timestamptz NOT NULL DEFAULT now(),
  locked_at timestamptz,
  locked_by text,
  last_error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS notifications (
  id uuid PRIMARY KEY,
  user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  session_id uuid REFERENCES chat_sessions(id) ON DELETE CASCADE,
  run_id uuid REFERENCES runs(id) ON DELETE CASCADE,
  tool_call_id uuid REFERENCES tool_calls(id) ON DELETE CASCADE,
  type text NOT NULL CHECK (
    type IN (
      'tool_started',
      'tool_completed',
      'tool_failed',
      'tool_timed_out',
      'run_completed',
      'run_failed',
      'run_timed_out'
    )
  ),
  title text NOT NULL,
  body text NOT NULL,
  dedupe_key text NOT NULL UNIQUE,
  metadata_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  read_at timestamptz,
  emailed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_messages_session_id ON messages(session_id);
CREATE INDEX IF NOT EXISTS idx_runs_session_id ON runs(session_id);
CREATE INDEX IF NOT EXISTS idx_tool_calls_run_id ON tool_calls(run_id);
CREATE INDEX IF NOT EXISTS idx_work_authors_work_id ON work_authors(work_id);
CREATE INDEX IF NOT EXISTS idx_work_subjects_work_id ON work_subjects(work_id);
CREATE INDEX IF NOT EXISTS idx_work_files_work_id ON work_files(work_id);
CREATE INDEX IF NOT EXISTS idx_chunks_work_id ON chunks(work_id);
CREATE INDEX IF NOT EXISTS idx_runtime_instances_session_id ON runtime_instances(session_id);
CREATE INDEX IF NOT EXISTS idx_artifacts_session_id ON artifacts(session_id);
CREATE INDEX IF NOT EXISTS idx_jobs_status_run_after ON jobs(status, run_after);
CREATE INDEX IF NOT EXISTS idx_notifications_user_created_at ON notifications(user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_notifications_user_read_created_at ON notifications(user_id, read_at, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_chunks_tsv ON chunks USING gin(tsv);
CREATE INDEX IF NOT EXISTS idx_chunks_embedding ON chunks USING hnsw (embedding vector_cosine_ops);
`,
  },
  {
    id: "0002_social_graph",
    sql: `
CREATE TABLE IF NOT EXISTS user_follows (
  follower_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  followed_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (follower_id, followed_id),
  CONSTRAINT user_follows_not_self CHECK (follower_id <> followed_id)
);

CREATE INDEX IF NOT EXISTS idx_user_follows_followed_id ON user_follows(followed_id);
CREATE INDEX IF NOT EXISTS idx_user_follows_follower_id ON user_follows(follower_id);
`,
  },
  {
    id: "0003_billing",
    sql: `
CREATE TABLE IF NOT EXISTS billing_events (
  id uuid PRIMARY KEY,
  user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  session_id uuid REFERENCES chat_sessions(id) ON DELETE SET NULL,
  run_id uuid REFERENCES runs(id) ON DELETE SET NULL,
  source text NOT NULL,
  provider text NOT NULL,
  model text NOT NULL,
  operation text NOT NULL,
  input_tokens integer NOT NULL DEFAULT 0,
  output_tokens integer NOT NULL DEFAULT 0,
  total_tokens integer NOT NULL DEFAULT 0,
  cached_input_tokens integer NOT NULL DEFAULT 0,
  cost_usd numeric(12, 6) NOT NULL DEFAULT 0,
  request_id text,
  request_json jsonb,
  response_json jsonb,
  metadata_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_billing_events_user_created_at ON billing_events(user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_billing_events_run_id ON billing_events(run_id);
`,
  },
  {
    id: "0004_analytics_events",
    sql: `
CREATE TABLE IF NOT EXISTS analytics_events (
  id uuid PRIMARY KEY,
  event text NOT NULL,
  user_id text REFERENCES users(id) ON DELETE SET NULL,
  session_id uuid REFERENCES chat_sessions(id) ON DELETE SET NULL,
  properties_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_analytics_events_created_at ON analytics_events(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_analytics_events_event_created_at ON analytics_events(event, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_analytics_events_session_id ON analytics_events(session_id);
`,
  },
  {
    id: "0005_agent_identities",
    sql: `
CREATE TABLE IF NOT EXISTS agent_identities (
  id uuid PRIMARY KEY,
  user_id text NOT NULL UNIQUE REFERENCES users(id) ON DELETE CASCADE,
  owner_user_id text REFERENCES users(id) ON DELETE SET NULL,
  name text NOT NULL,
  description text,
  api_key_prefix text NOT NULL UNIQUE,
  api_key_hash text NOT NULL UNIQUE,
  status text NOT NULL CHECK (status IN ('pending_claim', 'active', 'revoked')),
  verification_code text NOT NULL,
  claim_token text NOT NULL UNIQUE,
  metadata_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  last_used_at timestamptz,
  claimed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_agent_identities_owner_user_id ON agent_identities(owner_user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_agent_identities_claim_token ON agent_identities(claim_token);
CREATE INDEX IF NOT EXISTS idx_agent_identities_api_key_hash ON agent_identities(api_key_hash);
`,
  },
  {
    id: "0006_book_html",
    sql: `
ALTER TABLE work_files
  DROP CONSTRAINT IF EXISTS work_files_kind_check;

ALTER TABLE work_files
  ADD CONSTRAINT work_files_kind_check
  CHECK (kind IN ('raw', 'metadata', 'clean', 'chunks', 'book_html'));
`,
  },
  {
    id: "0007_notifications",
    sql: `
CREATE TABLE IF NOT EXISTS notifications (
  id uuid PRIMARY KEY,
  user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  session_id uuid REFERENCES chat_sessions(id) ON DELETE CASCADE,
  run_id uuid REFERENCES runs(id) ON DELETE CASCADE,
  tool_call_id uuid REFERENCES tool_calls(id) ON DELETE CASCADE,
  type text NOT NULL CHECK (
    type IN (
      'tool_started',
      'tool_completed',
      'tool_failed',
      'tool_timed_out',
      'run_completed',
      'run_failed',
      'run_timed_out'
    )
  ),
  title text NOT NULL,
  body text NOT NULL,
  dedupe_key text NOT NULL UNIQUE,
  metadata_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  read_at timestamptz,
  emailed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_notifications_user_created_at ON notifications(user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_notifications_user_read_created_at ON notifications(user_id, read_at, created_at DESC);
`,
  },
] as const;
