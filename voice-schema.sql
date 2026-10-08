-- Execute this against the SAME D1 database already bound to Discord Worker as DB.
-- Does NOT alter or delete your existing reminders table.
CREATE TABLE IF NOT EXISTS voice_jobs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  guild_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  channel_id TEXT NOT NULL,
  action TEXT NOT NULL CHECK (action IN ('play','pause','resume','skip','queue','stop')),
  url TEXT,
  created_at INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','processing','done','failed')),
  claimed_at INTEGER,
  finished_at INTEGER,
  error TEXT
);
CREATE INDEX IF NOT EXISTS idx_voice_jobs_status ON voice_jobs(status, id);
CREATE INDEX IF NOT EXISTS idx_voice_jobs_guild ON voice_jobs(guild_id, created_at);
