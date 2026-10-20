-- A late older snapshot needs one fresh anchor read before scoped catch-up.
-- Failed verification must not occupy every foreground pass or hide ready bases.
ALTER TABLE collection_ownership_bases ADD COLUMN last_attempt_at INTEGER NOT NULL DEFAULT 0;
ALTER TABLE collection_ownership_bases ADD COLUMN retry_at INTEGER NOT NULL DEFAULT 0;
CREATE INDEX collection_ownership_bases_due_idx
    ON collection_ownership_bases(chain_id, revision, retry_at, last_attempt_at, collection_id);
