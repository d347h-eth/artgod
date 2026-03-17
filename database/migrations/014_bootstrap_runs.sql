CREATE TABLE IF NOT EXISTS bootstrap_runs (
  run_id INTEGER PRIMARY KEY AUTOINCREMENT,
  chain_id INTEGER NOT NULL,
  collection_id INTEGER NOT NULL,
  request_slug TEXT NOT NULL,
  request_opensea_slug TEXT,
  request_address TEXT NOT NULL,
  request_standard TEXT NOT NULL,
  request_extension_key TEXT,
  metadata_mode TEXT NOT NULL,
  enumeration_mode TEXT NOT NULL,
  manual_token_ids_json TEXT,
  manual_range_start_token_id TEXT,
  manual_range_total_supply INTEGER,
  deployment_block INTEGER,
  status TEXT NOT NULL,
  anchor_block INTEGER,
  anchor_block_hash TEXT,
  anchor_block_timestamp INTEGER,
  error_code TEXT,
  error_message TEXT,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT DEFAULT CURRENT_TIMESTAMP,
  finished_at TEXT
);

CREATE INDEX IF NOT EXISTS bootstrap_runs_collection_idx
  ON bootstrap_runs (chain_id, collection_id, created_at DESC);

CREATE UNIQUE INDEX IF NOT EXISTS bootstrap_runs_active_uq
  ON bootstrap_runs (chain_id, collection_id)
  WHERE status IN ('requested', 'queued', 'metadata', 'ownership', 'backfill');

CREATE TABLE IF NOT EXISTS bootstrap_run_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id INTEGER NOT NULL,
  chain_id INTEGER NOT NULL,
  collection_id INTEGER NOT NULL,
  event_code TEXT NOT NULL,
  event_level TEXT NOT NULL,
  message TEXT NOT NULL,
  payload_json TEXT,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS bootstrap_run_events_run_idx
  ON bootstrap_run_events (run_id, created_at ASC);
