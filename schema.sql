-- Paste this SQL into Cloudflare D1 > your database > Console > Execute.
CREATE TABLE IF NOT EXISTS reminders (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  guild_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  channel_id TEXT NOT NULL,
  title TEXT NOT NULL,
  due_at INTEGER NOT NULL,
  next_attempt_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  locked_at INTEGER,
  sent_at INTEGER,
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'processing', 'sent', 'failed')),
  attempts INTEGER NOT NULL DEFAULT 0,
  last_error TEXT
);
CREATE INDEX IF NOT EXISTS idx_reminders_due ON reminders(status, next_attempt_at);
CREATE INDEX IF NOT EXISTS idx_reminders_owner ON reminders(guild_id, user_id, status, due_at);
