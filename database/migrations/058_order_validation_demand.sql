-- One coalesced obligation per current order, not per broker message/time bucket.
CREATE TABLE order_validation_demand (
    order_id TEXT PRIMARY KEY REFERENCES orders(id) ON DELETE CASCADE,
    chain_id INTEGER NOT NULL,
    generation INTEGER NOT NULL DEFAULT 1,
    revision INTEGER NOT NULL,
    required_at INTEGER NOT NULL,
    minimum_block INTEGER,
    anchor_independent INTEGER NOT NULL DEFAULT 0 CHECK (anchor_independent IN (0, 1)),
    pending INTEGER NOT NULL DEFAULT 1 CHECK (pending IN (0, 1)),
    proof_revision INTEGER,
    proof_at INTEGER,
    proof_block INTEGER,
    lease_owner TEXT,
    lease_version INTEGER NOT NULL DEFAULT 0,
    lease_until INTEGER NOT NULL DEFAULT 0,
    failures INTEGER NOT NULL DEFAULT 0,
    next_attempt_at INTEGER NOT NULL DEFAULT 0,
    last_error TEXT,
    updated_at INTEGER NOT NULL
);
CREATE INDEX order_validation_demand_due
    ON order_validation_demand(pending, chain_id, next_attempt_at, lease_until, updated_at, order_id);
