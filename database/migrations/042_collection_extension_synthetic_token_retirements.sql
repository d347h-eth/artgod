CREATE TABLE IF NOT EXISTS collection_extension_synthetic_token_retirements (
  chain_id INTEGER NOT NULL,
  collection_id INTEGER NOT NULL,
  contract_address TEXT NOT NULL,
  token_id TEXT NOT NULL,
  extension_key TEXT NOT NULL,
  retired_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (chain_id, collection_id, token_id, extension_key),
  FOREIGN KEY(collection_id) REFERENCES collections(collection_id)
);

CREATE INDEX IF NOT EXISTS collection_extension_synthetic_token_retirements_collection_idx
  ON collection_extension_synthetic_token_retirements (chain_id, collection_id, extension_key);
