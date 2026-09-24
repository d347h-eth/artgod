ALTER TABLE queue_outbox ADD COLUMN publication_stream_id TEXT;
ALTER TABLE queue_outbox ADD COLUMN publication_sequence INTEGER;
ALTER TABLE maker_order_revalidation_runs ADD COLUMN wakeup_outbox_id INTEGER REFERENCES queue_outbox(outbox_id) ON DELETE SET NULL;
ALTER TABLE maker_order_revalidation_runs ADD COLUMN wakeup_generation INTEGER NOT NULL DEFAULT 0;
ALTER TABLE maker_order_revalidation_runs ADD COLUMN recovery_checked_at INTEGER NOT NULL DEFAULT 0;
CREATE INDEX maker_order_revalidation_recovery ON maker_order_revalidation_runs(status, recovery_checked_at, updated_at, run_id);
