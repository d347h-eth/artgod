-- Old obligations are main work. Only newly attributed automatic repair demand is background.
ALTER TABLE order_validation_demand ADD COLUMN work_class TEXT NOT NULL DEFAULT 'main'
    CHECK (work_class IN ('main', 'gap_repair'));
DROP INDEX order_validation_demand_due;
CREATE INDEX order_validation_demand_due
    ON order_validation_demand(pending, chain_id, work_class, next_attempt_at, lease_until, updated_at, order_id);
