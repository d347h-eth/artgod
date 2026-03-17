CREATE INDEX IF NOT EXISTS collections_opensea_status_idx
  ON collections (chain_id, opensea_status, status);

CREATE INDEX IF NOT EXISTS collections_opensea_slug_idx
  ON collections (chain_id, opensea_slug);

ALTER TABLE orders ADD COLUMN source_status TEXT NOT NULL DEFAULT 'active';

CREATE INDEX IF NOT EXISTS orders_source_status_idx
  ON orders (chain_id, source_status);

CREATE INDEX IF NOT EXISTS orders_source_collection_status_idx
  ON orders (chain_id, source, collection_id, source_status);

CREATE TABLE IF NOT EXISTS offchain_order_observations (
  observation_id INTEGER PRIMARY KEY AUTOINCREMENT,
  chain_id INTEGER NOT NULL,
  collection_id INTEGER NOT NULL,
  source TEXT NOT NULL,
  channel TEXT NOT NULL,
  dedupe_key TEXT NOT NULL,
  event_type TEXT NOT NULL,
  order_id TEXT,
  run_id INTEGER,
  received_at INTEGER NOT NULL,
  source_event_at INTEGER,
  payload_json TEXT NOT NULL,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (chain_id, source, dedupe_key)
);

CREATE INDEX IF NOT EXISTS offchain_order_observations_collection_idx
  ON offchain_order_observations (chain_id, collection_id, channel, created_at DESC);

CREATE INDEX IF NOT EXISTS offchain_order_observations_order_idx
  ON offchain_order_observations (chain_id, order_id, created_at DESC);

CREATE INDEX IF NOT EXISTS offchain_order_observations_run_idx
  ON offchain_order_observations (chain_id, run_id, created_at DESC);

CREATE TABLE IF NOT EXISTS opensea_orderbook_runs (
  run_id INTEGER PRIMARY KEY AUTOINCREMENT,
  chain_id INTEGER NOT NULL,
  collection_id INTEGER NOT NULL,
  kind TEXT NOT NULL,
  status TEXT NOT NULL,
  started_at TEXT DEFAULT CURRENT_TIMESTAMP,
  completed_at TEXT,
  error_message TEXT
);

CREATE INDEX IF NOT EXISTS opensea_orderbook_runs_collection_idx
  ON opensea_orderbook_runs (chain_id, collection_id, kind, started_at DESC);

CREATE INDEX IF NOT EXISTS opensea_orderbook_runs_status_idx
  ON opensea_orderbook_runs (chain_id, status, started_at DESC);
