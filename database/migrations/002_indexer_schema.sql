-- Indexer core tables
CREATE TABLE IF NOT EXISTS blocks (
  chain_id INTEGER NOT NULL,
  block_number INTEGER NOT NULL,
  block_hash TEXT NOT NULL,
  parent_hash TEXT NOT NULL,
  timestamp INTEGER NOT NULL,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (chain_id, block_number)
);

CREATE TABLE IF NOT EXISTS transactions (
  chain_id INTEGER NOT NULL,
  tx_hash TEXT NOT NULL,
  from_address TEXT NOT NULL,
  to_address TEXT,
  input TEXT NOT NULL,
  block_number INTEGER NOT NULL,
  block_hash TEXT NOT NULL,
  block_timestamp INTEGER NOT NULL,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (chain_id, tx_hash)
);

CREATE INDEX IF NOT EXISTS transactions_block_idx
  ON transactions (chain_id, block_number);

CREATE TABLE IF NOT EXISTS sync_state (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at TEXT DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS nft_transfer_events (
  chain_id INTEGER NOT NULL,
  contract_address TEXT NOT NULL,
  from_address TEXT NOT NULL,
  to_address TEXT NOT NULL,
  token_id TEXT NOT NULL,
  amount TEXT NOT NULL,
  block_number INTEGER NOT NULL,
  block_hash TEXT NOT NULL,
  block_timestamp INTEGER NOT NULL,
  tx_hash TEXT NOT NULL,
  log_index INTEGER NOT NULL,
  kind TEXT NOT NULL,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (chain_id, tx_hash, log_index, contract_address, token_id)
);

CREATE INDEX IF NOT EXISTS nft_transfer_events_contract_token_idx
  ON nft_transfer_events (chain_id, contract_address, token_id);
CREATE INDEX IF NOT EXISTS nft_transfer_events_tx_idx
  ON nft_transfer_events (chain_id, tx_hash);

CREATE TABLE IF NOT EXISTS nft_balances (
  chain_id INTEGER NOT NULL,
  contract_address TEXT NOT NULL,
  token_id TEXT NOT NULL,
  owner TEXT NOT NULL,
  amount TEXT NOT NULL,
  last_block_number INTEGER NOT NULL,
  last_block_hash TEXT NOT NULL,
  last_block_timestamp INTEGER NOT NULL,
  last_tx_hash TEXT NOT NULL,
  last_log_index INTEGER NOT NULL,
  updated_at TEXT DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (chain_id, contract_address, token_id, owner)
);

CREATE INDEX IF NOT EXISTS nft_balances_owner_idx
  ON nft_balances (chain_id, owner);
