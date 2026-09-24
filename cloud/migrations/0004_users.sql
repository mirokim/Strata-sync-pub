-- People who signed in (Google), so the app can show who is on the team. Written when a signed-in
-- user calls the API (throttled), backfilled once from the OAuth grants in KV. The team token is
-- not a person and never appears here.
CREATE TABLE IF NOT EXISTS users (
  sub        TEXT PRIMARY KEY,
  email      TEXT NOT NULL DEFAULT '',
  name       TEXT NOT NULL DEFAULT '',
  picture    TEXT NOT NULL DEFAULT '',
  first_seen INTEGER NOT NULL,
  last_seen  INTEGER NOT NULL
);
