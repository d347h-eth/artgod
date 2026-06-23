CREATE TABLE IF NOT EXISTS trading_jobs (
  job_id TEXT PRIMARY KEY,
  bot_kind TEXT NOT NULL,
  chain_id INTEGER NOT NULL,
  collection_id INTEGER NOT NULL,
  status TEXT NOT NULL,
  target_kind TEXT NOT NULL,
  token_id TEXT,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT DEFAULT CURRENT_TIMESTAMP,
  archived_at TEXT,
  revision INTEGER NOT NULL DEFAULT 1,
  FOREIGN KEY(collection_id) REFERENCES collections(collection_id),
  CHECK (bot_kind IN ('bidding', 'sniping')),
  CHECK (status IN ('enabled', 'paused', 'archived')),
  CHECK (target_kind IN ('token', 'collection', 'competitive_trait')),
  CHECK (revision > 0),
  CHECK (
    (target_kind = 'token' AND token_id IS NOT NULL)
    OR (target_kind != 'token' AND token_id IS NULL)
  )
);

CREATE INDEX IF NOT EXISTS trading_jobs_collection_idx
  ON trading_jobs (chain_id, collection_id, bot_kind, status, updated_at DESC, job_id ASC);

CREATE INDEX IF NOT EXISTS trading_jobs_status_idx
  ON trading_jobs (bot_kind, status, updated_at DESC, job_id ASC);

CREATE UNIQUE INDEX IF NOT EXISTS trading_jobs_token_target_uq
  ON trading_jobs (chain_id, collection_id, bot_kind, target_kind, token_id)
  WHERE target_kind = 'token' AND status != 'archived';

CREATE TABLE IF NOT EXISTS trading_bidding_job_specs (
  job_id TEXT PRIMARY KEY,
  floor_wei TEXT NOT NULL,
  ceiling_wei TEXT NOT NULL,
  delta_wei TEXT NOT NULL,
  quantity INTEGER,
  target_traits_json TEXT,
  competitor_traits_json TEXT,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY(job_id) REFERENCES trading_jobs(job_id) ON DELETE CASCADE,
  CHECK (floor_wei != ''),
  CHECK (ceiling_wei != ''),
  CHECK (delta_wei != '')
);

CREATE TABLE IF NOT EXISTS trading_bidding_job_runtime_state (
  job_id TEXT PRIMARY KEY,
  current_price_wei TEXT,
  active_order_id TEXT,
  active_protocol_address TEXT,
  active_expiration_time_ms INTEGER,
  last_run_at TEXT,
  last_error TEXT,
  cancellation_requested_at TEXT,
  cancellation_completed_at TEXT,
  cancellation_error TEXT,
  updated_at TEXT DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY(job_id) REFERENCES trading_jobs(job_id) ON DELETE CASCADE
);

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

CREATE TABLE IF NOT EXISTS trading_job_commands (
  command_id INTEGER PRIMARY KEY AUTOINCREMENT,
  job_id TEXT NOT NULL,
  bot_kind TEXT NOT NULL,
  command_kind TEXT NOT NULL,
  status TEXT NOT NULL,
  requested_revision INTEGER NOT NULL,
  payload_json TEXT NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP,
  claimed_at TEXT,
  completed_at TEXT,
  FOREIGN KEY(job_id) REFERENCES trading_jobs(job_id) ON DELETE CASCADE,
  CHECK (bot_kind IN ('bidding', 'sniping')),
  CHECK (command_kind IN ('job_created', 'job_updated', 'job_paused', 'job_archived', 'cancel_active_offer')),
  CHECK (status IN ('pending', 'processing', 'completed', 'failed_retry', 'failed_terminal')),
  CHECK (requested_revision > 0),
  CHECK (attempts >= 0)
);

CREATE INDEX IF NOT EXISTS trading_job_commands_pending_idx
  ON trading_job_commands (bot_kind, status, command_id ASC);

CREATE INDEX IF NOT EXISTS trading_job_commands_job_idx
  ON trading_job_commands (job_id, command_id ASC);
