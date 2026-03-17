-- Activities domain (minimal first pass)
CREATE TABLE IF NOT EXISTS activities (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  chain_id INTEGER NOT NULL,
  collection_id INTEGER NOT NULL,
  kind TEXT NOT NULL,
  contract_address TEXT NOT NULL,
  token_id TEXT NOT NULL,
  from_address TEXT,
  to_address TEXT,
  amount TEXT,
  block_number INTEGER NOT NULL,
  tx_hash TEXT NOT NULL,
  log_index INTEGER NOT NULL,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (chain_id, tx_hash, log_index, collection_id, token_id, kind)
);

CREATE INDEX IF NOT EXISTS activities_collection_token_idx
  ON activities (chain_id, collection_id, token_id);
CREATE INDEX IF NOT EXISTS activities_contract_token_idx
  ON activities (chain_id, contract_address, token_id);
CREATE INDEX IF NOT EXISTS activities_from_idx
  ON activities (chain_id, from_address);
CREATE INDEX IF NOT EXISTS activities_to_idx
  ON activities (chain_id, to_address);
