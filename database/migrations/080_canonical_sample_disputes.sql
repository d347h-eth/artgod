-- Explicitly conflicting observations need prompt verification, independently of
-- ordinary delayed maturity checks. Generations fence confirmation RPC in flight.
ALTER TABLE blocks ADD COLUMN canonical_check_disputed INTEGER NOT NULL DEFAULT 0
    CHECK (canonical_check_disputed IN (0, 1));
ALTER TABLE blocks ADD COLUMN canonical_check_generation INTEGER NOT NULL DEFAULT 0
    CHECK (canonical_check_generation >= 0);
CREATE INDEX blocks_canonical_disputes ON blocks(chain_id, block_number)
    WHERE canonical_check_disputed = 1;

-- Rebinding one accepted height must not scan all admissions in a revision.
CREATE INDEX chain_head_samples_block
    ON chain_head_samples(chain_id, revision, block_number);
