CREATE TABLE IF NOT EXISTS collection_trait_stats (
  chain_id INTEGER NOT NULL,
  contract_address TEXT NOT NULL,
  attribute_key_id INTEGER NOT NULL,
  attribute_id INTEGER NOT NULL,
  token_count INTEGER NOT NULL,
  updated_at TEXT DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (chain_id, contract_address, attribute_id),
  FOREIGN KEY(attribute_key_id) REFERENCES attribute_keys(id),
  FOREIGN KEY(attribute_id) REFERENCES attributes(id)
);

CREATE INDEX IF NOT EXISTS collection_trait_stats_contract_idx
  ON collection_trait_stats (chain_id, contract_address);

CREATE INDEX IF NOT EXISTS collection_trait_stats_key_idx
  ON collection_trait_stats (attribute_key_id);
