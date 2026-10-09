-- Required verification belongs to the block commit, independent of a scheduler publication.
ALTER TABLE blocks ADD COLUMN canonical_check_pending INTEGER NOT NULL DEFAULT 0
    CHECK (canonical_check_pending IN (0, 1));
ALTER TABLE blocks ADD COLUMN canonical_check_retry_at INTEGER NOT NULL DEFAULT 0;
CREATE INDEX blocks_pending_canonical_checks
    ON blocks(chain_id, canonical_check_retry_at, block_number)
    WHERE canonical_check_pending = 1;
