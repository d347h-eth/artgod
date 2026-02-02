-- Orders domain (minimal first pass)
CREATE TABLE IF NOT EXISTS orders (
  id TEXT PRIMARY KEY,
  chain_id INTEGER NOT NULL,
  kind TEXT NOT NULL,
  side TEXT,
  source TEXT,
  maker TEXT NOT NULL,
  taker TEXT,
  contract_address TEXT NOT NULL,
  token_id TEXT,
  token_set_id TEXT,
  token_set_schema_hash TEXT,
  price TEXT,
  currency TEXT,
  valid_from INTEGER,
  valid_until INTEGER,
  fillability_status TEXT NOT NULL,
  raw_data TEXT,
  block_number INTEGER,
  block_hash TEXT,
  block_timestamp INTEGER,
  tx_hash TEXT,
  tx_from TEXT,
  tx_to TEXT,
  tx_input TEXT,
  log_index INTEGER,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS orders_maker_idx
  ON orders (chain_id, maker);
CREATE INDEX IF NOT EXISTS orders_contract_token_idx
  ON orders (chain_id, contract_address, token_id);
CREATE INDEX IF NOT EXISTS orders_token_set_idx
  ON orders (chain_id, token_set_id, token_set_schema_hash);
CREATE INDEX IF NOT EXISTS orders_status_idx
  ON orders (chain_id, fillability_status);
