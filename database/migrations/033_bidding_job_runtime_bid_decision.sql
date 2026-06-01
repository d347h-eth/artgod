ALTER TABLE trading_bidding_job_runtime_state
  ADD COLUMN bid_position TEXT;

ALTER TABLE trading_bidding_job_runtime_state
  ADD COLUMN bid_constraints_json TEXT;

ALTER TABLE trading_bidding_job_runtime_state
  ADD COLUMN competitor_price_wei TEXT;
