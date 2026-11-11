-- Permanent per-token obligations. Broker messages never own reveal/readiness progress.
CREATE TABLE metadata_pending (
    chain_id INTEGER NOT NULL,
    collection_id INTEGER NOT NULL REFERENCES collections(collection_id) ON DELETE CASCADE,
    token_id TEXT NOT NULL,
    options_json TEXT NOT NULL,
    attempts INTEGER NOT NULL DEFAULT 0,
    first_pending_at INTEGER NOT NULL,
    last_attempt_at INTEGER,
    due_at INTEGER NOT NULL,
    reason TEXT NOT NULL,
    lease_owner TEXT,
    PRIMARY KEY (chain_id, collection_id, token_id)
);
-- Due/lease availability is indexed per collection; inactive collections are not swept.
CREATE INDEX metadata_pending_collection_due
    ON metadata_pending(chain_id, collection_id, due_at, token_id);
