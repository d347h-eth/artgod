-- Cleanup walks a bounded page even when its oldest mappings remain pinned.
CREATE TABLE chain_head_sample_cleanup (
    singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
    after_chain_id INTEGER NOT NULL,
    after_revision INTEGER NOT NULL,
    after_admission_watermark INTEGER NOT NULL
);

CREATE INDEX order_validation_claim_admission
    ON order_validation_demand(chain_id, claim_chain_revision, claim_admission_sequence, lease_until)
    WHERE lease_owner IS NOT NULL;
CREATE INDEX maker_validation_admission
    ON maker_order_revalidation_runs(chain_id, admission_sequence)
    WHERE status = 'pending';
CREATE INDEX maker_validation_requested_admission
    ON maker_order_revalidation_runs(chain_id, requested_admission_sequence)
    WHERE status = 'pending';
