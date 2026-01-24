-- Fills domain (minimal first pass)
CREATE TABLE IF NOT EXISTS fills (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  chain_id INTEGER NOT NULL,
  kind TEXT NOT NULL,
  order_id TEXT,
  order_side TEXT,
  maker TEXT,
  taker TEXT,
  contract TEXT NOT NULL,
  token_id TEXT NOT NULL,
  amount TEXT,
  price TEXT,
  currency TEXT,
  block_number INTEGER NOT NULL,
  block_hash TEXT NOT NULL,
  block_timestamp INTEGER NOT NULL,
  tx_hash TEXT NOT NULL,
  log_index INTEGER NOT NULL,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (chain_id, tx_hash, log_index, contract, token_id, kind)
);

CREATE INDEX IF NOT EXISTS fills_contract_token_idx
  ON fills (chain_id, contract, token_id);
CREATE INDEX IF NOT EXISTS fills_maker_idx
  ON fills (chain_id, maker);
CREATE INDEX IF NOT EXISTS fills_taker_idx
  ON fills (chain_id, taker);
CREATE INDEX IF NOT EXISTS fills_tx_idx
  ON fills (chain_id, tx_hash);
