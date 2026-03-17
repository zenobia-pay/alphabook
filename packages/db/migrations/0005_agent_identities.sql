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
