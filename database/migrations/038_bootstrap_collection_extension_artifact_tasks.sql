-- Bootstrap collection-extension artifact tasks (progress + failures)
CREATE TABLE IF NOT EXISTS bootstrap_collection_extension_artifact_tasks (
  run_id INTEGER NOT NULL,
  chain_id INTEGER NOT NULL,
  collection_id INTEGER NOT NULL,
  contract_address TEXT NOT NULL,
  token_id TEXT NOT NULL,
  extension_key TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'retry', 'succeeded', 'failed_terminal')),
  attempts INTEGER NOT NULL DEFAULT 0,
  next_attempt_at INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,
  last_error_at INTEGER,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (run_id, token_id, extension_key)
);

CREATE INDEX IF NOT EXISTS bootstrap_collection_extension_artifact_due_idx
  ON bootstrap_collection_extension_artifact_tasks (run_id, status, next_attempt_at);

CREATE INDEX IF NOT EXISTS bootstrap_collection_extension_artifact_status_idx
  ON bootstrap_collection_extension_artifact_tasks (run_id, status);

CREATE INDEX IF NOT EXISTS bootstrap_collection_extension_artifact_collection_idx
  ON bootstrap_collection_extension_artifact_tasks (chain_id, collection_id, run_id);
