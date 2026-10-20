-- Chain proof survives demand cleanup and remains distinct from the block that
-- first established a terminal lifecycle result.
ALTER TABLE orders ADD COLUMN proof_block_number INTEGER;
ALTER TABLE orders ADD COLUMN proof_block_hash TEXT;
ALTER TABLE orders ADD COLUMN proof_chain_revision INTEGER;
ALTER TABLE orders ADD COLUMN proof_admission_sequence INTEGER NOT NULL DEFAULT 0;
ALTER TABLE orders ADD COLUMN proof_order_revision INTEGER;
ALTER TABLE orders ADD COLUMN proof_at INTEGER;
CREATE INDEX orders_proof_block_idx ON orders(chain_id, proof_block_number);

-- Availability is scoped to its publishing source. Missing-order observations
-- are allowed, so a withdrawal arriving before its declaration keeps its scope.
CREATE TABLE order_source_observations (
    chain_id INTEGER NOT NULL,
    collection_id INTEGER NOT NULL REFERENCES collections(collection_id) ON DELETE CASCADE,
    order_id TEXT NOT NULL,
    source_id TEXT NOT NULL,
    source_status TEXT NOT NULL,
    observation_key TEXT NOT NULL,
    declared_quantity TEXT,
    source_observed_at INTEGER,
    admitted_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL,
    PRIMARY KEY(chain_id, order_id, source_id)
);
CREATE INDEX order_source_observations_expiry_idx ON order_source_observations(expires_at);

-- Remaining quantity is unknown until chain validation. Keep declared size in
-- original_quantity and source-reported amounts in source observations.
ALTER TABLE orders RENAME COLUMN quantity TO previous_quantity;
ALTER TABLE orders ADD COLUMN quantity TEXT;
UPDATE orders SET quantity = previous_quantity;
ALTER TABLE orders DROP COLUMN previous_quantity;
