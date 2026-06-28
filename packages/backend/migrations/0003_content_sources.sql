-- Content sources: websites, Slack channels, Teams channels
CREATE TABLE IF NOT EXISTS sources (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  type TEXT NOT NULL,          -- 'website' | 'slack' | 'teams' | 'rss'
  name TEXT NOT NULL,
  config TEXT NOT NULL,        -- JSON: { url, webhook_secret, channel_name, ... }
  last_scanned_at TEXT,
  scan_frequency TEXT DEFAULT 'daily',  -- 'hourly' | 'daily' | 'weekly' | 'manual'
  status TEXT NOT NULL DEFAULT 'active',
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_sources_user ON sources(user_id);

-- Raw content items extracted from sources
CREATE TABLE IF NOT EXISTS source_content (
  id TEXT PRIMARY KEY,
  source_id TEXT NOT NULL REFERENCES sources(id),
  user_id TEXT NOT NULL REFERENCES users(id),
  title TEXT,
  body TEXT NOT NULL,
  url TEXT,
  content_hash TEXT NOT NULL,
  extracted_at TEXT DEFAULT (datetime('now')),
  UNIQUE(source_id, content_hash)
);

CREATE INDEX IF NOT EXISTS idx_source_content_source ON source_content(source_id, extracted_at);

-- Link generated posts back to source content
ALTER TABLE posts ADD COLUMN source_content_id TEXT REFERENCES source_content(id);
