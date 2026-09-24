-- Legacy runs keep their independent replay identity; new runs may coalesce trusted hints.
ALTER TABLE maker_order_revalidation_runs ADD COLUMN scope_key TEXT;
ALTER TABLE maker_order_revalidation_runs ADD COLUMN source_payload_json TEXT;
ALTER TABLE maker_order_revalidation_runs ADD COLUMN requested_payload_json TEXT;
ALTER TABLE maker_order_revalidation_runs ADD COLUMN requested_at INTEGER NOT NULL DEFAULT 0;
ALTER TABLE maker_order_revalidation_runs ADD COLUMN generation INTEGER NOT NULL DEFAULT 1;
ALTER TABLE maker_order_revalidation_runs ADD COLUMN pass_generation INTEGER NOT NULL DEFAULT 1;
ALTER TABLE maker_order_revalidation_runs ADD COLUMN pass_started_at INTEGER NOT NULL DEFAULT 0;
CREATE UNIQUE INDEX maker_validation_scope
    ON maker_order_revalidation_runs(chain_id, scope_key)
    WHERE scope_key IS NOT NULL;
CREATE INDEX maker_validation_coverage_cleanup
    ON maker_order_revalidation_runs(status, origin_stream_id, origin_consumer, recovery_checked_at, origin_sequence);
