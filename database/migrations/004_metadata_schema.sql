-- Metadata domain (minimal first pass)
CREATE TABLE IF NOT EXISTS token_metadata (
  chain_id INTEGER NOT NULL,
  contract TEXT NOT NULL,
  token_id TEXT NOT NULL,
  uri TEXT NOT NULL,
  name TEXT,
  description TEXT,
  image TEXT,
  animation_url TEXT,
  external_url TEXT,
  attributes_json TEXT,
  raw_json TEXT,
  block_number INTEGER,
  block_hash TEXT,
  block_timestamp INTEGER,
  tx_hash TEXT,
  log_index INTEGER,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (chain_id, contract, token_id)
);

CREATE INDEX IF NOT EXISTS token_metadata_contract_idx
  ON token_metadata (chain_id, contract);

CREATE INDEX IF NOT EXISTS token_metadata_block_idx
  ON token_metadata (chain_id, block_number);
