-- Apply to existing Cloudflare D1 once: npx wrangler d1 execute DB --remote --file=./free-games.sql
-- Safe to run again; existing reminders and voice jobs are untouched.
CREATE TABLE IF NOT EXISTS free_settings (
  guild_id TEXT PRIMARY KEY,
  channel_id TEXT NOT NULL,
  role_id TEXT,
  stores TEXT NOT NULL DEFAULT 'all',
  kinds TEXT NOT NULL DEFAULT 'game',
  min_price REAL NOT NULL DEFAULT 0.01,
  notify_upcoming INTEGER NOT NULL DEFAULT 0,
  theme TEXT NOT NULL DEFAULT 'rich',
  enabled INTEGER NOT NULL DEFAULT 1,
  bootstrapped INTEGER NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS free_offers (
  offer_key TEXT PRIMARY KEY,
  source TEXT NOT NULL,
  store TEXT NOT NULL,
  kind TEXT NOT NULL,
  phase TEXT NOT NULL,
  title TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  image_url TEXT,
  claim_url TEXT NOT NULL,
  source_url TEXT,
  original_price REAL NOT NULL DEFAULT 0,
  currency TEXT NOT NULL DEFAULT 'USD',
  start_at INTEGER,
  end_at INTEGER,
  first_seen_at INTEGER NOT NULL,
  last_seen_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_free_offers_phase ON free_offers(phase, last_seen_at, end_at);
CREATE TABLE IF NOT EXISTS free_deliveries (
  guild_id TEXT NOT NULL,
  offer_key TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','processing','sent','failed')),
  attempts INTEGER NOT NULL DEFAULT 0,
  next_attempt_at INTEGER NOT NULL,
  locked_at INTEGER,
  sent_at INTEGER,
  last_error TEXT,
  PRIMARY KEY(guild_id, offer_key)
);
CREATE INDEX IF NOT EXISTS idx_free_deliveries_due ON free_deliveries(status, next_attempt_at);
CREATE TABLE IF NOT EXISTS free_sync (
  name TEXT PRIMARY KEY,
  succeeded_at INTEGER,
  locked_at INTEGER,
  last_error TEXT
);
