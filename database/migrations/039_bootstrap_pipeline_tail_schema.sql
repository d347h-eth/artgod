-- Bootstrap pipeline additive schema appended after the stable base migrations.
ALTER TABLE bootstrap_runs ADD COLUMN request_image_cache_mode TEXT DEFAULT 'off';
ALTER TABLE bootstrap_runs ADD COLUMN request_image_cache_max_dimension INTEGER;

CREATE TABLE IF NOT EXISTS bootstrap_run_steps (
  run_id INTEGER NOT NULL,
  step_key TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  blocking INTEGER NOT NULL DEFAULT 1,
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
