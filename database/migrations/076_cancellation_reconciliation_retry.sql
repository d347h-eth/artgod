-- Retry scheduling is independent of cancellation outcome and display freshness.
ALTER TABLE trading_bidding_order_cancellations
  ADD COLUMN reconciliation_retry_at INTEGER NOT NULL DEFAULT 0 CHECK (reconciliation_retry_at >= 0);

DROP INDEX IF EXISTS trading_bidding_order_cancellations_failed_reconcile_idx;
CREATE INDEX trading_bidding_order_cancellations_reconcile_due_idx
  ON trading_bidding_order_cancellations (chain_id, reconciliation_retry_at, updated_at, requested_at, order_id)
  WHERE completed_at IS NULL;
