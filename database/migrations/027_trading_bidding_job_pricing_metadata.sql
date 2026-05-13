ALTER TABLE trading_bidding_job_specs
  ADD COLUMN price_tier_id TEXT;

ALTER TABLE trading_bidding_job_specs
  ADD COLUMN pricing_source_json TEXT;

CREATE INDEX IF NOT EXISTS trading_bidding_job_specs_price_tier_idx
  ON trading_bidding_job_specs (price_tier_id)
  WHERE price_tier_id IS NOT NULL;
