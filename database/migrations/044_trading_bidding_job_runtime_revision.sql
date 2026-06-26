ALTER TABLE trading_bidding_job_runtime_state
  ADD COLUMN job_revision INTEGER;

ALTER TABLE trading_bidding_order_cancellations
  ADD COLUMN job_revision INTEGER;

ALTER TABLE trading_bidding_order_cancellations
  ADD COLUMN price_wei TEXT;

ALTER TABLE trading_bidding_order_cancellations
  ADD COLUMN protocol_address TEXT;

ALTER TABLE trading_bidding_order_cancellations
  ADD COLUMN placed_at TEXT;

ALTER TABLE trading_bidding_order_cancellations
  ADD COLUMN expiration_time_ms INTEGER;
