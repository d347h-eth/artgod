-- Validation reuse belongs to one canonical history, in addition to an order revision.
ALTER TABLE order_validation_demand ADD COLUMN proof_chain_revision INTEGER;

-- Current-order validation has one main execution lane, independent of historical hint class.
DROP INDEX order_validation_demand_due;
ALTER TABLE order_validation_demand DROP COLUMN work_class;
CREATE INDEX order_validation_demand_due
    ON order_validation_demand(pending, chain_id, next_attempt_at, lease_until, updated_at, order_id);
