CREATE TABLE IF NOT EXISTS feed_works (
  work_id uuid PRIMARY KEY REFERENCES works(id) ON DELETE CASCADE,
  rank integer NOT NULL,
  score double precision NOT NULL,
  feed_label text,
  title text NOT NULL,
  gutenberg_id bigint,
  language text,
  release_date date,
  rights_status text,
  summary text,
  metadata_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  authors text[] NOT NULL DEFAULT ARRAY[]::text[],
  subjects text[] NOT NULL DEFAULT ARRAY[]::text[],
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS site_stats (
  key text PRIMARY KEY,
  value_json jsonb NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_feed_works_rank ON feed_works(rank);
