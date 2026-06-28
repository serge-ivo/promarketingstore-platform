-- Standalone posts (not campaign-bound). Phase 1 posting engine.
CREATE TABLE IF NOT EXISTS posts (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  social_account_id TEXT REFERENCES social_accounts(id),
  campaign_id TEXT REFERENCES campaigns(id),
  platform TEXT NOT NULL,
  content TEXT NOT NULL,
  media_key TEXT,
  media_type TEXT,
  scheduled_for TEXT,
  posted_at TEXT,
  platform_post_id TEXT,
  status TEXT NOT NULL DEFAULT 'draft',
  error TEXT,
  retry_count INTEGER NOT NULL DEFAULT 0,
  caption_hash TEXT,
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_posts_scheduled ON posts(status, scheduled_for);
CREATE INDEX IF NOT EXISTS idx_posts_user ON posts(user_id, created_at);
CREATE INDEX IF NOT EXISTS idx_posts_dedup ON posts(social_account_id, caption_hash);

-- Add metadata column to oauth_states for PKCE code_verifier storage
ALTER TABLE oauth_states ADD COLUMN metadata TEXT;

-- Add refresh token columns to social_accounts (X tokens expire in 2h, need refresh)
ALTER TABLE social_accounts ADD COLUMN refresh_token_encrypted TEXT;
ALTER TABLE social_accounts ADD COLUMN refresh_token_iv TEXT;
