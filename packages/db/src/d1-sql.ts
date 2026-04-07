export const D1_SCHEMA_SQL = `
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  email TEXT UNIQUE,
  name TEXT,
  avatar_url TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS chat_sessions (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  title TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS messages (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES chat_sessions(id) ON DELETE CASCADE,
  role TEXT NOT NULL CHECK (role IN ('user', 'assistant', 'system', 'tool')),
  content TEXT NOT NULL,
  metadata_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS runs (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES chat_sessions(id) ON DELETE CASCADE,
  status TEXT NOT NULL CHECK (status IN ('queued', 'running', 'completed', 'failed', 'timed_out')),
  started_at TEXT NOT NULL,
  completed_at TEXT,
  planner_turns INTEGER NOT NULL DEFAULT 0,
  owner_instance_id TEXT,
  heartbeat_at TEXT,
  lease_expires_at TEXT,
  active_tool_call_id TEXT
);

CREATE TABLE IF NOT EXISTS tool_calls (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  tool_name TEXT NOT NULL,
  args_json TEXT NOT NULL,
  result_json TEXT,
  args_ref TEXT,
  result_ref TEXT,
  args_summary TEXT,
  result_summary TEXT,
  started_at TEXT NOT NULL,
  completed_at TEXT,
  status TEXT NOT NULL CHECK (status IN ('queued', 'running', 'completed', 'failed', 'timed_out'))
);

CREATE TABLE IF NOT EXISTS run_events (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  session_id TEXT NOT NULL REFERENCES chat_sessions(id) ON DELETE CASCADE,
  sequence INTEGER NOT NULL,
  event TEXT NOT NULL,
  data_json TEXT NOT NULL DEFAULT '{}',
  payload_ref TEXT,
  summary_text TEXT,
  phase TEXT,
  status TEXT,
  tool_call_id TEXT,
  runtime_id TEXT,
  retention_class TEXT CHECK (retention_class IN ('product-critical', 'debug-index', 'debug-blob')),
  created_at TEXT NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_run_events_run_id_sequence ON run_events(run_id, sequence);
CREATE INDEX IF NOT EXISTS idx_run_events_run_id_created_at ON run_events(run_id, created_at ASC);

CREATE TABLE IF NOT EXISTS authors (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  sort_name TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS works (
  id TEXT PRIMARY KEY,
  gutenberg_id INTEGER UNIQUE,
  title TEXT NOT NULL,
  language TEXT,
  release_date TEXT,
  rights_status TEXT,
  summary TEXT,
  metadata_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS work_authors (
  work_id TEXT NOT NULL REFERENCES works(id) ON DELETE CASCADE,
  author_id TEXT NOT NULL REFERENCES authors(id) ON DELETE CASCADE,
  PRIMARY KEY (work_id, author_id)
);

CREATE TABLE IF NOT EXISTS subjects (
  id TEXT PRIMARY KEY,
  label TEXT NOT NULL UNIQUE
);

CREATE TABLE IF NOT EXISTS work_subjects (
  work_id TEXT NOT NULL REFERENCES works(id) ON DELETE CASCADE,
  subject_id TEXT NOT NULL REFERENCES subjects(id) ON DELETE CASCADE,
  PRIMARY KEY (work_id, subject_id)
);

CREATE TABLE IF NOT EXISTS work_files (
  id TEXT PRIMARY KEY,
  work_id TEXT NOT NULL REFERENCES works(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('raw', 'metadata', 'clean', 'chunks', 'book_html')),
  r2_key TEXT NOT NULL UNIQUE,
  byte_size INTEGER,
  sha256 TEXT,
  metadata_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS runtime_instances (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES chat_sessions(id) ON DELETE CASCADE,
  runtime_id TEXT NOT NULL UNIQUE,
  provider TEXT NOT NULL,
  provider_machine_id TEXT,
  status TEXT NOT NULL CHECK (status IN ('creating', 'ready', 'busy', 'destroyed', 'failed', 'expired')),
  manifest_json TEXT NOT NULL DEFAULT '{}',
  manifest_ref TEXT,
  task_spec_json TEXT NOT NULL DEFAULT '{}',
  selected_work_ids_json TEXT NOT NULL DEFAULT '[]',
  selected_chunk_ids_json TEXT NOT NULL DEFAULT '[]',
  file_catalog_ref TEXT,
  research_mode TEXT,
  shard_id TEXT,
  aggregator INTEGER NOT NULL DEFAULT 0,
  last_used_at TEXT,
  expires_at TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS artifacts (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES chat_sessions(id) ON DELETE CASCADE,
  runtime_id TEXT,
  r2_key TEXT NOT NULL UNIQUE,
  blob_ref TEXT,
  filename TEXT NOT NULL,
  mime_type TEXT NOT NULL,
  byte_size INTEGER,
  summary_text TEXT,
  metadata_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS jobs (
  id TEXT PRIMARY KEY,
  type TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('queued', 'running', 'completed', 'failed')),
  attempts INTEGER NOT NULL DEFAULT 0,
  run_after TEXT NOT NULL,
  locked_at TEXT,
  locked_by TEXT,
  last_error TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS notifications (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  session_id TEXT REFERENCES chat_sessions(id) ON DELETE CASCADE,
  run_id TEXT REFERENCES runs(id) ON DELETE CASCADE,
  tool_call_id TEXT REFERENCES tool_calls(id) ON DELETE CASCADE,
  type TEXT NOT NULL CHECK (
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
  title TEXT NOT NULL,
  body TEXT NOT NULL,
  dedupe_key TEXT NOT NULL UNIQUE,
  metadata_json TEXT NOT NULL DEFAULT '{}',
  read_at TEXT,
  emailed_at TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS user_follows (
  follower_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  followed_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL,
  PRIMARY KEY (follower_id, followed_id),
  CONSTRAINT user_follows_not_self CHECK (follower_id <> followed_id)
);

CREATE TABLE IF NOT EXISTS billing_events (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  session_id TEXT REFERENCES chat_sessions(id) ON DELETE SET NULL,
  run_id TEXT REFERENCES runs(id) ON DELETE SET NULL,
  source TEXT NOT NULL,
  provider TEXT NOT NULL,
  model TEXT NOT NULL,
  operation TEXT NOT NULL,
  input_tokens INTEGER NOT NULL DEFAULT 0,
  output_tokens INTEGER NOT NULL DEFAULT 0,
  total_tokens INTEGER NOT NULL DEFAULT 0,
  cached_input_tokens INTEGER NOT NULL DEFAULT 0,
  cost_usd REAL NOT NULL DEFAULT 0,
  request_id TEXT,
  request_json TEXT,
  response_json TEXT,
  metadata_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS analytics_events (
  id TEXT PRIMARY KEY,
  event TEXT NOT NULL,
  user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  session_id TEXT REFERENCES chat_sessions(id) ON DELETE SET NULL,
  properties_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS agent_identities (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL UNIQUE REFERENCES users(id) ON DELETE CASCADE,
  owner_user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  name TEXT NOT NULL,
  description TEXT,
  api_key_prefix TEXT NOT NULL UNIQUE,
  api_key_hash TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL CHECK (status IN ('pending_claim', 'active', 'revoked')),
  verification_code TEXT NOT NULL,
  claim_token TEXT NOT NULL UNIQUE,
  metadata_json TEXT NOT NULL DEFAULT '{}',
  last_used_at TEXT,
  claimed_at TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS feed_works (
  work_id TEXT PRIMARY KEY REFERENCES works(id) ON DELETE CASCADE,
  rank INTEGER NOT NULL,
  score REAL NOT NULL,
  feed_label TEXT,
  title TEXT NOT NULL,
  gutenberg_id INTEGER,
  language TEXT,
  release_date TEXT,
  rights_status TEXT,
  summary TEXT,
  metadata_json TEXT NOT NULL DEFAULT '{}',
  authors_json TEXT NOT NULL DEFAULT '[]',
  subjects_json TEXT NOT NULL DEFAULT '[]',
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS site_stats (
  key TEXT PRIMARY KEY,
  value_json TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_messages_session_id ON messages(session_id);
CREATE INDEX IF NOT EXISTS idx_runs_session_id ON runs(session_id);
CREATE INDEX IF NOT EXISTS idx_tool_calls_run_id ON tool_calls(run_id);
CREATE INDEX IF NOT EXISTS idx_work_authors_work_id ON work_authors(work_id);
CREATE INDEX IF NOT EXISTS idx_work_subjects_work_id ON work_subjects(work_id);
CREATE INDEX IF NOT EXISTS idx_work_files_work_id ON work_files(work_id);
CREATE INDEX IF NOT EXISTS idx_runtime_instances_session_id ON runtime_instances(session_id);
CREATE INDEX IF NOT EXISTS idx_artifacts_session_id ON artifacts(session_id);
CREATE INDEX IF NOT EXISTS idx_jobs_status_run_after ON jobs(status, run_after);
CREATE INDEX IF NOT EXISTS idx_notifications_user_created_at ON notifications(user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_notifications_user_read_created_at ON notifications(user_id, read_at, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_user_follows_followed_id ON user_follows(followed_id);
CREATE INDEX IF NOT EXISTS idx_user_follows_follower_id ON user_follows(follower_id);
CREATE INDEX IF NOT EXISTS idx_billing_events_user_created_at ON billing_events(user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_billing_events_run_id ON billing_events(run_id);
CREATE INDEX IF NOT EXISTS idx_analytics_events_created_at ON analytics_events(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_analytics_events_event_created_at ON analytics_events(event, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_analytics_events_session_id ON analytics_events(session_id);
CREATE INDEX IF NOT EXISTS idx_agent_identities_owner_user_id ON agent_identities(owner_user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_agent_identities_claim_token ON agent_identities(claim_token);
CREATE INDEX IF NOT EXISTS idx_agent_identities_api_key_hash ON agent_identities(api_key_hash);
CREATE INDEX IF NOT EXISTS idx_feed_works_rank ON feed_works(rank);

CREATE VIEW IF NOT EXISTS corpus_documents AS
SELECT
  w.id AS document_id,
  COALESCE(NULLIF(json_extract(w.metadata_json, '$.sourceAdapter'), ''), 'gutenberg') AS source_adapter,
  CAST(w.gutenberg_id AS TEXT) AS external_source_id,
  w.title,
  w.language,
  w.release_date,
  w.rights_status,
  w.summary,
  w.metadata_json,
  w.created_at,
  w.updated_at
FROM works w;

CREATE VIEW IF NOT EXISTS corpus_document_files AS
SELECT
  wf.id,
  wf.work_id AS document_id,
  COALESCE(NULLIF(json_extract(w.metadata_json, '$.sourceAdapter'), ''), 'gutenberg') AS source_adapter,
  wf.kind,
  wf.r2_key,
  wf.byte_size,
  wf.sha256,
  wf.metadata_json,
  wf.created_at
FROM work_files wf
JOIN works w ON w.id = wf.work_id;

`;
