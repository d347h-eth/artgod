CREATE TABLE IF NOT EXISTS trading_bot_runtime_state (
  bot_kind TEXT NOT NULL,
  chain_id INTEGER NOT NULL,
  wallet_id TEXT NOT NULL,
  address TEXT NOT NULL,
  state TEXT NOT NULL,
  heartbeat_at TEXT NOT NULL,
  started_at TEXT NOT NULL,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  last_error TEXT,
  PRIMARY KEY (bot_kind, chain_id, wallet_id),
  CHECK (bot_kind IN ('bidding', 'sniping')),
  CHECK (state IN ('bootstrapping', 'running', 'stopped', 'error')),
  CHECK (wallet_id != ''),
  CHECK (address != '')
);

CREATE INDEX IF NOT EXISTS trading_bot_runtime_state_live_idx
  ON trading_bot_runtime_state (bot_kind, chain_id, state, heartbeat_at DESC);
