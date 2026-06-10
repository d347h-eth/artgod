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
  request_image_cache_mode TEXT NOT NULL DEFAULT 'off'
    CHECK (request_image_cache_mode IN ('off', 'cache_once', 'refresh_on_metadata')),
  request_image_cache_max_dimension INTEGER
    CHECK (
      request_image_cache_max_dimension IS NULL
      OR request_image_cache_max_dimension > 0
    ),
  deployment_block INTEGER,
  status TEXT NOT NULL
    CHECK (status IN (
      'requested',
      'queued',
      'metadata',
      'image_cache',
      'ownership',
      'backfill',
      'completed',
      'failed'
    )),
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
  WHERE status IN ('requested', 'queued', 'metadata', 'image_cache', 'ownership', 'backfill');

CREATE TABLE IF NOT EXISTS bootstrap_run_steps (
  run_id INTEGER NOT NULL,
  step_key TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN (
      'pending',
      'ready',
      'running',
      'paused',
      'succeeded',
      'failed_retry',
      'failed_terminal',
      'skipped'
    )),
  blocking INTEGER NOT NULL DEFAULT 1 CHECK (blocking IN (0, 1)),
  depends_on_json TEXT NOT NULL DEFAULT '[]',
  attempts INTEGER NOT NULL DEFAULT 0,
  next_attempt_at INTEGER NOT NULL DEFAULT 0,
  lease_owner TEXT,
  lease_until INTEGER,
  progress_completed INTEGER NOT NULL DEFAULT 0,
  progress_total INTEGER,
  config_json TEXT,
  result_json TEXT,
  last_error TEXT,
  last_error_at INTEGER,
  started_at TEXT,
  finished_at TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (run_id, step_key)
);

CREATE INDEX IF NOT EXISTS bootstrap_run_steps_ready_idx
  ON bootstrap_run_steps (status, next_attempt_at, lease_until);

CREATE INDEX IF NOT EXISTS bootstrap_run_steps_run_idx
  ON bootstrap_run_steps (run_id, step_key);

CREATE TABLE IF NOT EXISTS bootstrap_run_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id INTEGER NOT NULL,
  chain_id INTEGER NOT NULL,
  collection_id INTEGER NOT NULL,
  event_code TEXT NOT NULL,
  event_level TEXT NOT NULL CHECK (event_level IN ('info', 'warn', 'error')),
  message TEXT NOT NULL,
  payload_json TEXT,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS bootstrap_run_events_run_idx
  ON bootstrap_run_events (run_id, created_at ASC);
