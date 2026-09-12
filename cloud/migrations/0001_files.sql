-- One row per vault path, tombstoned on delete so clients can learn about removals.
CREATE TABLE IF NOT EXISTS files (
  path        TEXT PRIMARY KEY,
  etag        TEXT NOT NULL,          -- sha256 hex of the content (client-computable)
  size        INTEGER NOT NULL,
  mtime       INTEGER NOT NULL,       -- client file mtime, ms since epoch
  author      TEXT NOT NULL DEFAULT '',
  deleted     INTEGER NOT NULL DEFAULT 0,
  seq         INTEGER NOT NULL,       -- change sequence; manifest?since=<seq> returns rows with seq > since
  updated_at  INTEGER NOT NULL        -- server time, ms
);
CREATE INDEX IF NOT EXISTS files_seq ON files(seq);

-- Single-row counter that hands out `seq` values.
CREATE TABLE IF NOT EXISTS counters (
  name  TEXT PRIMARY KEY,
  value INTEGER NOT NULL
);
INSERT OR IGNORE INTO counters(name, value) VALUES ('seq', 0);
