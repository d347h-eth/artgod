CREATE INDEX IF NOT EXISTS trading_jobs_chain_bot_status_collection_idx
  ON trading_jobs (chain_id, bot_kind, status, collection_id, job_id);
