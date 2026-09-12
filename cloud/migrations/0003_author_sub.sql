-- Who saved a row, as a stable identity (OAuth sub, or 'service' for the team token), next to the
-- display name. Authorisation decisions (e.g. taking a document back into a personal space) compare
-- this, never the editable display name. Rows written before this migration carry ''.
ALTER TABLE files ADD COLUMN author_sub TEXT NOT NULL DEFAULT '';
