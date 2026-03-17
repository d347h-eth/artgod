CREATE TABLE IF NOT EXISTS collection_extension_installs (
  chain_id INTEGER NOT NULL,
  collection_id INTEGER NOT NULL,
  extension_key TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1,
  config_json TEXT NOT NULL,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (chain_id, collection_id),
  FOREIGN KEY(collection_id) REFERENCES collections(collection_id)
);

CREATE INDEX IF NOT EXISTS collection_extension_installs_extension_idx
  ON collection_extension_installs (extension_key);

CREATE TABLE IF NOT EXISTS token_extension_artifacts (
  chain_id INTEGER NOT NULL,
  collection_id INTEGER NOT NULL,
  contract_address TEXT NOT NULL,
  token_id TEXT NOT NULL,
  extension_key TEXT NOT NULL,
  artifact_ref TEXT NOT NULL,
  uri TEXT,
  raw_json TEXT,
  attributes_json TEXT,
  image TEXT,
  animation_url TEXT,
  html_content TEXT,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (chain_id, collection_id, token_id, extension_key, artifact_ref),
  FOREIGN KEY(chain_id, collection_id, token_id)
    REFERENCES tokens(chain_id, collection_id, token_id)
);

CREATE INDEX IF NOT EXISTS token_extension_artifacts_collection_idx
  ON token_extension_artifacts (chain_id, collection_id, extension_key);
