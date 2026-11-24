-- Apply once to the D1 database bound as DB. No raw email bodies or locations.
CREATE TABLE IF NOT EXISTS cad_calls (
  id TEXT PRIMARY KEY NOT NULL,
  gmail_message_id TEXT UNIQUE NOT NULL,
  dispatch_datetime TEXT NOT NULL,
  dispatch_date TEXT NOT NULL,
  dispatch_time TEXT NOT NULL,
  dispatch_nature TEXT NOT NULL CHECK (length(dispatch_nature) BETWEEN 1 AND 160),
  source_year INTEGER NOT NULL CHECK (source_year BETWEEN 1900 AND 2200),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
CREATE INDEX IF NOT EXISTS cad_calls_dispatch_datetime_idx
  ON cad_calls (dispatch_datetime DESC, id DESC);
CREATE INDEX IF NOT EXISTS cad_calls_year_dispatch_datetime_idx
  ON cad_calls (source_year, dispatch_datetime DESC, id DESC);

CREATE TABLE IF NOT EXISTS cad_poll_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ran_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  checked INTEGER,
  stored INTEGER,
  inbox_total INTEGER,
  duration_ms INTEGER,
  error TEXT
);
CREATE INDEX IF NOT EXISTS cad_poll_log_ran_at_idx ON cad_poll_log (ran_at DESC, id DESC);

-- No API can edit metadata. Missing count_complete:<year> means false.
-- Set a year's value to 'true' only after its full historical migration is verified.
CREATE TABLE IF NOT EXISTS cad_metadata (
  key TEXT PRIMARY KEY NOT NULL,
  value TEXT NOT NULL DEFAULT 'false'
);
