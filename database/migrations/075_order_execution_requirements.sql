-- Unresolved source executions belong to SQLite, never to an unacknowledged
-- broker delivery. Each transaction retains its own receipt obligation.
CREATE TABLE order_execution_requirements (
    chain_id INTEGER NOT NULL,
    order_id TEXT NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
    transaction_hash TEXT NOT NULL,
    required_at INTEGER NOT NULL,
    lease_owner TEXT,
    lease_version INTEGER NOT NULL DEFAULT 0,
    lease_until INTEGER NOT NULL DEFAULT 0,
    failures INTEGER NOT NULL DEFAULT 0,
    next_attempt_at INTEGER NOT NULL DEFAULT 0,
    last_error TEXT,
    updated_at INTEGER NOT NULL,
    PRIMARY KEY (chain_id, order_id, transaction_hash)
);
CREATE INDEX order_execution_requirements_due
    ON order_execution_requirements(chain_id, next_attempt_at, lease_until, updated_at);
