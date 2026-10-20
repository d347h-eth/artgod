-- Reconciliation selects source-local availability and freshness, independently
-- of the first source that supplied the immutable order declaration.
CREATE INDEX order_source_observations_reconciliation_idx
    ON order_source_observations(chain_id,collection_id,source_id,source_status,admitted_at,order_id);
