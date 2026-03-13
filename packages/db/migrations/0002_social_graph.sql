CREATE TABLE IF NOT EXISTS user_follows (
  follower_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  followed_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (follower_id, followed_id),
  CONSTRAINT user_follows_not_self CHECK (follower_id <> followed_id)
);

CREATE INDEX IF NOT EXISTS idx_user_follows_followed_id ON user_follows(followed_id);
CREATE INDEX IF NOT EXISTS idx_user_follows_follower_id ON user_follows(follower_id);
