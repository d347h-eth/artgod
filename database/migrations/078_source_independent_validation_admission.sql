-- Local admission order replaces source clocks as validation coverage authority.
ALTER TABLE order_validation_demand ADD COLUMN observation_key TEXT;
ALTER TABLE order_validation_demand ADD COLUMN admission_sequence INTEGER NOT NULL DEFAULT 0 CHECK (admission_sequence >= 0);
ALTER TABLE order_validation_demand ADD COLUMN minimum_block_hash TEXT;
ALTER TABLE order_validation_demand ADD COLUMN proof_block_hash TEXT;
ALTER TABLE order_validation_demand ADD COLUMN proof_admission_sequence INTEGER NOT NULL DEFAULT 0 CHECK (proof_admission_sequence >= 0);
CREATE INDEX order_validation_admission ON order_validation_demand(chain_id, admission_sequence) WHERE pending=1;
ALTER TABLE order_validation_demand ADD COLUMN refresh_at INTEGER;
CREATE INDEX order_validation_freshness ON order_validation_demand(chain_id, refresh_at, order_id) WHERE pending=0 AND refresh_at IS NOT NULL;
CREATE INDEX order_validation_pending_scan ON order_validation_demand(chain_id, order_id) WHERE pending=1;
CREATE TABLE order_validation_sweeps (
    chain_id INTEGER PRIMARY KEY,
    after_order_id TEXT NOT NULL DEFAULT ''
);

-- Only structurally accepted, supported declarations enter the RPC lane.
-- Existing rows do not acquire proof or readiness through migration inference.
ALTER TABLE orders ADD COLUMN validation_ready INTEGER NOT NULL DEFAULT 0 CHECK (validation_ready IN (0,1));

-- An admitted follow-up may change the current requirement while its older lease
-- still runs. Keep the old mapping/header pins independently until release/expiry.
ALTER TABLE order_validation_demand ADD COLUMN claim_admission_sequence INTEGER;
ALTER TABLE order_validation_demand ADD COLUMN claim_block INTEGER;
ALTER TABLE order_validation_demand ADD COLUMN claim_block_hash TEXT;
ALTER TABLE order_validation_demand ADD COLUMN claim_chain_revision INTEGER;
CREATE INDEX order_validation_claim_pins ON order_validation_demand(chain_id, lease_until, claim_block) WHERE lease_owner IS NOT NULL;
