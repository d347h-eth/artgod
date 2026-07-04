CREATE INDEX IF NOT EXISTS trading_bidding_order_cancellations_failed_reconcile_idx
  ON trading_bidding_order_cancellations (chain_id, updated_at ASC, requested_at ASC)
  WHERE completed_at IS NULL AND cancellation_error IS NOT NULL;
