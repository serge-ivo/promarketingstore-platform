CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  email TEXT UNIQUE NOT NULL,
  name TEXT,
  avatar_url TEXT,
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS keys (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  provider TEXT NOT NULL,
  encrypted_key TEXT NOT NULL,
  iv TEXT NOT NULL,
  created_at TEXT DEFAULT (datetime('now')),
  UNIQUE(user_id, provider)
);

CREATE TABLE IF NOT EXISTS campaigns (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  name TEXT NOT NULL,
  goal TEXT,
  audience TEXT,
  channels TEXT DEFAULT '[]',
  status TEXT DEFAULT 'draft',
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS content (
  id TEXT PRIMARY KEY,
  campaign_id TEXT REFERENCES campaigns(id),
  user_id TEXT NOT NULL REFERENCES users(id),
  type TEXT NOT NULL,
  platform TEXT,
  body TEXT NOT NULL,
  status TEXT DEFAULT 'draft',
  scheduled_at TEXT,
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS sessions (
  token TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  created_at TEXT DEFAULT (datetime('now')),
  expires_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS social_accounts (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  provider TEXT NOT NULL,
  account_id TEXT NOT NULL,
  page_id TEXT,
  display_name TEXT NOT NULL,
  access_token_encrypted TEXT NOT NULL,
  access_token_iv TEXT NOT NULL,
  scopes TEXT NOT NULL DEFAULT '[]',
  token_expires_at TEXT,
  status TEXT NOT NULL DEFAULT 'connected',
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now')),
  UNIQUE(user_id, provider, account_id)
);

CREATE TABLE IF NOT EXISTS oauth_states (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  provider TEXT NOT NULL,
  return_to TEXT,
  created_at TEXT DEFAULT (datetime('now')),
  expires_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS campaign_runs (
  id TEXT PRIMARY KEY,
  campaign_id TEXT NOT NULL REFERENCES campaigns(id),
  user_id TEXT NOT NULL REFERENCES users(id),
  agent_instance_id TEXT,
  workflow_instance_id TEXT,
  objective TEXT NOT NULL,
  plan_json TEXT,
  status TEXT NOT NULL DEFAULT 'planning',
  autopilot_level TEXT NOT NULL DEFAULT 'approve_first',
  cost_cap_usd REAL NOT NULL DEFAULT 20.0,
  cost_spent_usd REAL NOT NULL DEFAULT 0.0,
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS campaign_posts (
  id TEXT PRIMARY KEY,
  campaign_id TEXT NOT NULL REFERENCES campaigns(id),
  run_id TEXT REFERENCES campaign_runs(id),
  user_id TEXT NOT NULL REFERENCES users(id),
  provider TEXT NOT NULL,
  social_account_id TEXT REFERENCES social_accounts(id),
  post_type TEXT NOT NULL DEFAULT 'text',
  body TEXT NOT NULL,
  media_r2_key TEXT,
  scheduled_at TEXT,
  status TEXT NOT NULL DEFAULT 'draft',
  approval_status TEXT NOT NULL DEFAULT 'pending',
  idempotency_key TEXT NOT NULL,
  external_post_id TEXT,
  external_permalink TEXT,
  last_error_code TEXT,
  last_error_message TEXT,
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now')),
  UNIQUE(idempotency_key)
);

CREATE TABLE IF NOT EXISTS post_attempts (
  id TEXT PRIMARY KEY,
  post_id TEXT NOT NULL REFERENCES campaign_posts(id),
  provider TEXT NOT NULL,
  request_json TEXT NOT NULL,
  response_json TEXT,
  success INTEGER NOT NULL DEFAULT 0,
  error_code TEXT,
  error_message TEXT,
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS post_metrics (
  id TEXT PRIMARY KEY,
  post_id TEXT NOT NULL REFERENCES campaign_posts(id),
  provider TEXT NOT NULL,
  metrics_json TEXT NOT NULL,
  collected_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS agent_events (
  id TEXT PRIMARY KEY,
  campaign_id TEXT REFERENCES campaigns(id),
  run_id TEXT REFERENCES campaign_runs(id),
  user_id TEXT NOT NULL REFERENCES users(id),
  event_type TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS campaign_memory (
  id TEXT PRIMARY KEY,
  campaign_id TEXT NOT NULL REFERENCES campaigns(id),
  user_id TEXT NOT NULL REFERENCES users(id),
  key TEXT NOT NULL,
  value TEXT NOT NULL,
  source TEXT NOT NULL DEFAULT 'agent',
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now')),
  UNIQUE(campaign_id, key)
);

CREATE TABLE IF NOT EXISTS brand_profiles (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  name TEXT NOT NULL,
  voice_json TEXT NOT NULL DEFAULT '{}',
  audience_json TEXT NOT NULL DEFAULT '{}',
  blocked_terms_json TEXT NOT NULL DEFAULT '[]',
  approval_rules_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS cost_ledger (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES campaign_runs(id),
  campaign_id TEXT NOT NULL REFERENCES campaigns(id),
  user_id TEXT NOT NULL REFERENCES users(id),
  role TEXT NOT NULL,
  provider TEXT NOT NULL,
  model TEXT NOT NULL,
  tokens_in INTEGER NOT NULL DEFAULT 0,
  tokens_out INTEGER NOT NULL DEFAULT 0,
  cost_usd REAL NOT NULL DEFAULT 0,
  created_at TEXT DEFAULT (datetime('now'))
);
