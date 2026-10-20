-- Maker runs expand scopes into the one ordinary validation lane. Source time is
-- diagnostic only; every source pass retains one local causal admission.
ALTER TABLE maker_order_revalidation_runs ADD COLUMN admission_sequence INTEGER NOT NULL DEFAULT 0;
ALTER TABLE maker_order_revalidation_runs ADD COLUMN requested_admission_sequence INTEGER NOT NULL DEFAULT 0;
ALTER TABLE maker_order_revalidation_runs ADD COLUMN observation_key TEXT;
ALTER TABLE maker_order_revalidation_runs ADD COLUMN requested_observation_key TEXT;
ALTER TABLE maker_order_revalidation_runs DROP COLUMN isolate_order_id;

DROP INDEX maker_validation_active_scope;
CREATE INDEX maker_validation_active_scope
    ON maker_order_revalidation_runs(chain_id,scope_maker,required_chain_revision,required_block_number,requested_admission_sequence)
    WHERE status='pending';
