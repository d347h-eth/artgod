-- Token + attribute normalization and token sets (minimal)
CREATE TABLE IF NOT EXISTS tokens (
  chain_id INTEGER NOT NULL,
  collection_id INTEGER NOT NULL,
  contract_address TEXT NOT NULL,
  token_id TEXT NOT NULL,
  -- Mirrors TOKEN_RECORD_KIND; canonical is a real onchain token row.
  record_kind TEXT NOT NULL DEFAULT 'canonical' CHECK (record_kind IN ('canonical', 'extension_synthetic')),
  record_source_key TEXT,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (chain_id, collection_id, token_id),
  FOREIGN KEY(collection_id) REFERENCES collections(collection_id)
);

CREATE UNIQUE INDEX IF NOT EXISTS tokens_chain_contract_token_uq
  ON tokens (chain_id, contract_address, token_id);
CREATE INDEX IF NOT EXISTS tokens_collection_idx
  ON tokens (chain_id, collection_id);
CREATE INDEX IF NOT EXISTS tokens_record_kind_idx
  ON tokens (chain_id, collection_id, record_kind, record_source_key);

CREATE TABLE IF NOT EXISTS attribute_keys (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  chain_id INTEGER NOT NULL,
  collection_id INTEGER NOT NULL,
  contract_address TEXT NOT NULL,
  key TEXT NOT NULL,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (chain_id, collection_id, key)
);

CREATE INDEX IF NOT EXISTS attribute_keys_collection_idx
  ON attribute_keys (chain_id, collection_id);

CREATE TABLE IF NOT EXISTS attributes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  chain_id INTEGER NOT NULL,
  collection_id INTEGER NOT NULL,
  contract_address TEXT NOT NULL,
  attribute_key_id INTEGER NOT NULL,
  value TEXT NOT NULL,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (chain_id, collection_id, attribute_key_id, value),
  FOREIGN KEY(attribute_key_id) REFERENCES attribute_keys(id)
);

CREATE INDEX IF NOT EXISTS attributes_key_idx
  ON attributes (attribute_key_id);
CREATE INDEX IF NOT EXISTS attributes_collection_idx
  ON attributes (chain_id, collection_id);

CREATE TABLE IF NOT EXISTS token_attributes (
  chain_id INTEGER NOT NULL,
  collection_id INTEGER NOT NULL,
  contract_address TEXT NOT NULL,
  token_id TEXT NOT NULL,
  attribute_id INTEGER NOT NULL,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (chain_id, collection_id, token_id, attribute_id),
  FOREIGN KEY(attribute_id) REFERENCES attributes(id)
);

CREATE INDEX IF NOT EXISTS token_attributes_attribute_idx
  ON token_attributes (attribute_id);
CREATE INDEX IF NOT EXISTS token_attributes_collection_idx
  ON token_attributes (chain_id, collection_id, token_id);

CREATE TABLE IF NOT EXISTS token_sets (
  chain_id INTEGER NOT NULL,
  collection_id INTEGER NOT NULL,
  id TEXT NOT NULL,
  schema_hash TEXT NOT NULL,
  schema_json TEXT NOT NULL,
  contract_address TEXT NOT NULL,
  attribute_id INTEGER,
  merkle_root TEXT,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (chain_id, collection_id, id, schema_hash),
  FOREIGN KEY(attribute_id) REFERENCES attributes(id)
);

CREATE INDEX IF NOT EXISTS token_sets_collection_idx
  ON token_sets (chain_id, collection_id);

CREATE TABLE IF NOT EXISTS token_sets_tokens (
  chain_id INTEGER NOT NULL,
  collection_id INTEGER NOT NULL,
  token_set_id TEXT NOT NULL,
  token_set_schema_hash TEXT NOT NULL,
  contract_address TEXT NOT NULL,
  token_id TEXT NOT NULL,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (chain_id, collection_id, token_set_id, token_set_schema_hash, token_id)
);

CREATE INDEX IF NOT EXISTS token_sets_tokens_set_idx
  ON token_sets_tokens (chain_id, collection_id, token_set_id, token_set_schema_hash);
