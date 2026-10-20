-- Existing durable maker runs are also read-visible scope invalidations. No
-- separate expansion queue is needed. Null evidence on older runs grants no
-- canonical coverage and is not reconstructed during this migration.
ALTER TABLE maker_order_revalidation_runs ADD COLUMN scope_kind TEXT;
ALTER TABLE maker_order_revalidation_runs ADD COLUMN scope_maker TEXT;
ALTER TABLE maker_order_revalidation_runs ADD COLUMN scope_collection_id INTEGER;
ALTER TABLE maker_order_revalidation_runs ADD COLUMN scope_token_id TEXT;
ALTER TABLE maker_order_revalidation_runs ADD COLUMN scope_reason TEXT;
ALTER TABLE maker_order_revalidation_runs ADD COLUMN scope_currency TEXT;
ALTER TABLE maker_order_revalidation_runs ADD COLUMN required_chain_revision INTEGER;
ALTER TABLE maker_order_revalidation_runs ADD COLUMN required_block_number INTEGER;
ALTER TABLE maker_order_revalidation_runs ADD COLUMN required_block_hash TEXT;

CREATE INDEX maker_validation_active_scope
    ON maker_order_revalidation_runs(chain_id,scope_maker,required_chain_revision,required_block_number)
    WHERE status='pending' AND required_block_number IS NOT NULL;
