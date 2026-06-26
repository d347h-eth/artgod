CREATE TABLE IF NOT EXISTS trading_bidding_order_cancellations (
  order_id TEXT PRIMARY KEY,
  job_id TEXT NOT NULL,
  chain_id INTEGER NOT NULL,
  collection_id INTEGER NOT NULL,
  maker TEXT NOT NULL,
  requested_at TEXT NOT NULL,
  completed_at TEXT,
  cancellation_error TEXT,
  updated_at TEXT DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY(job_id) REFERENCES trading_jobs(job_id) ON DELETE CASCADE,
  FOREIGN KEY(collection_id) REFERENCES collections(collection_id)
);

CREATE INDEX IF NOT EXISTS trading_bidding_order_cancellations_collection_idx
  ON trading_bidding_order_cancellations (chain_id, collection_id, maker, completed_at, order_id);
