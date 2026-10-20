-- Foreground retries are independent for shared effects and each collection.
-- Failed collection RPC cannot occupy the oldest ready selection indefinitely.
ALTER TABLE chain_sync_progress ADD COLUMN retry_at INTEGER NOT NULL DEFAULT 0;
ALTER TABLE chain_sync_progress ADD COLUMN last_attempt_at INTEGER NOT NULL DEFAULT 0;
ALTER TABLE collection_sync_progress ADD COLUMN retry_at INTEGER NOT NULL DEFAULT 0;
ALTER TABLE collection_sync_progress ADD COLUMN last_attempt_at INTEGER NOT NULL DEFAULT 0;
CREATE INDEX collection_sync_progress_due_idx
    ON collection_sync_progress(chain_id, retry_at, last_attempt_at, collection_id);
CREATE INDEX collection_ownership_bases_anchor_idx
    ON collection_ownership_bases(chain_id, revision, anchor_block, collection_id);
