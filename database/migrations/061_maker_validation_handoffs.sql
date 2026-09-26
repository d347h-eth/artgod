-- A maker cursor may pass an unresolved order only after durable per-order admission.
-- The isolation target survives successful prefix checkpoints and process restarts.
ALTER TABLE maker_order_revalidation_runs
    ADD COLUMN isolate_order_id TEXT;
ALTER TABLE maker_order_revalidation_runs
    ADD COLUMN deferred_orders INTEGER NOT NULL DEFAULT 0 CHECK (deferred_orders >= 0);
