CREATE TABLE IF NOT EXISTS queue_outbox (
  outbox_id INTEGER PRIMARY KEY AUTOINCREMENT,
  queue_name TEXT NOT NULL,
  job_id TEXT NOT NULL,
  job_kind TEXT NOT NULL,
  job_json TEXT NOT NULL,
  chain_id INTEGER NOT NULL,
  collection_id INTEGER,
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'sent', 'failed_retry', 'failed_terminal')),
  attempts INTEGER NOT NULL DEFAULT 0,
  next_attempt_at INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,
  last_error_at INTEGER,
  sent_at TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(queue_name, job_id)
);

CREATE INDEX IF NOT EXISTS queue_outbox_due_idx
  ON queue_outbox (status, next_attempt_at, outbox_id);

CREATE INDEX IF NOT EXISTS queue_outbox_collection_idx
  ON queue_outbox (chain_id, collection_id, status);

CREATE TABLE IF NOT EXISTS metadata_refresh_runs (
  run_id TEXT PRIMARY KEY,
  chain_id INTEGER NOT NULL,
  collection_id INTEGER NOT NULL,
  reason TEXT NOT NULL,
  source_job_id TEXT NOT NULL,
  trace_id TEXT NOT NULL,
  stats_job_json TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'finalized')),
  stats_queue_outbox_id INTEGER,
  finalized_at TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY(stats_queue_outbox_id) REFERENCES queue_outbox(outbox_id)
);

CREATE INDEX IF NOT EXISTS metadata_refresh_runs_collection_status_idx
  ON metadata_refresh_runs (chain_id, collection_id, status);

CREATE TABLE IF NOT EXISTS metadata_refresh_extension_artifact_tasks (
  run_id TEXT NOT NULL,
  chain_id INTEGER NOT NULL,
  collection_id INTEGER NOT NULL,
  contract_address TEXT NOT NULL,
  token_id TEXT NOT NULL,
  extension_key TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'succeeded', 'skipped', 'failed_terminal')),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (run_id, token_id, extension_key),
  FOREIGN KEY(run_id) REFERENCES metadata_refresh_runs(run_id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS metadata_refresh_extension_artifact_tasks_status_idx
  ON metadata_refresh_extension_artifact_tasks (run_id, status);

CREATE INDEX IF NOT EXISTS metadata_refresh_extension_artifact_tasks_collection_idx
  ON metadata_refresh_extension_artifact_tasks (chain_id, collection_id, run_id);
