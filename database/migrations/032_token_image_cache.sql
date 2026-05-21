ALTER TABLE bootstrap_runs
ADD COLUMN request_image_cache_enabled INTEGER NOT NULL DEFAULT 0
CHECK (request_image_cache_enabled IN (0, 1));

ALTER TABLE bootstrap_runs
ADD COLUMN request_image_cache_max_dimension INTEGER
CHECK (
  request_image_cache_max_dimension IS NULL
  OR request_image_cache_max_dimension > 0
);

CREATE TABLE IF NOT EXISTS token_image_cache (
  run_id INTEGER NOT NULL,
  chain_id INTEGER NOT NULL,
  collection_id INTEGER NOT NULL,
  contract_address TEXT NOT NULL,
  token_id TEXT NOT NULL,
  source_image_url TEXT NOT NULL,
  requested_max_dimension INTEGER,
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'retry', 'succeeded', 'failed_terminal')),
  attempts INTEGER NOT NULL DEFAULT 0,
  next_attempt_at INTEGER NOT NULL DEFAULT 0,
  cache_key TEXT,
  content_type TEXT,
  source_bytes INTEGER,
  cached_bytes INTEGER,
  width INTEGER,
  height INTEGER,
  relative_path TEXT,
  public_path TEXT,
  last_error TEXT,
  last_error_at INTEGER,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (chain_id, collection_id, token_id)
);

CREATE INDEX IF NOT EXISTS token_image_cache_run_status_idx
  ON token_image_cache (run_id, status, next_attempt_at);

CREATE INDEX IF NOT EXISTS token_image_cache_public_path_idx
  ON token_image_cache (public_path)
  WHERE status = 'succeeded' AND public_path IS NOT NULL;
