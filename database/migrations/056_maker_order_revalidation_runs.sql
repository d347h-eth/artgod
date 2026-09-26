-- One checkpoint per admitted maker request, never one receipt per candidate order.
CREATE TABLE maker_order_revalidation_runs (
    run_id TEXT PRIMARY KEY,
    chain_id INTEGER NOT NULL,
    source_job_id TEXT NOT NULL,
    payload_json TEXT NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('pending', 'completed')),
    after_id TEXT NOT NULL DEFAULT '',
    upper_order_id TEXT NOT NULL,
    upper_rowid INTEGER NOT NULL,
    lease_owner TEXT,
    lease_version INTEGER NOT NULL DEFAULT 0,
    lease_until INTEGER NOT NULL DEFAULT 0,
    step INTEGER NOT NULL DEFAULT 0,
    resolved_orders INTEGER NOT NULL DEFAULT 0,
    failures INTEGER NOT NULL DEFAULT 0,
    last_error TEXT,
    origin_stream_id TEXT,
    origin_consumer TEXT,
    origin_sequence INTEGER,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    UNIQUE (chain_id, source_job_id)
);

CREATE INDEX maker_order_revalidation_pending
    ON maker_order_revalidation_runs(status, lease_until, updated_at);
CREATE INDEX maker_order_revalidation_completed
    ON maker_order_revalidation_runs(status, origin_stream_id, origin_consumer, origin_sequence);
