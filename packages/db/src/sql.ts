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
  kind text NOT NULL CHECK (kind IN ('raw', 'metadata', 'clean', 'chunks')),
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
CREATE INDEX IF NOT EXISTS idx_chunks_tsv ON chunks USING gin(tsv);
CREATE INDEX IF NOT EXISTS idx_chunks_embedding ON chunks USING hnsw (embedding vector_cosine_ops);
`,
  },
] as const;
