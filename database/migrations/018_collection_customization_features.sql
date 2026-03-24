CREATE TABLE IF NOT EXISTS collection_customization_features (
  chain_id INTEGER NOT NULL,
  collection_id INTEGER NOT NULL,
  feature_key TEXT NOT NULL,
  selected_source TEXT NOT NULL,
  user_config_json TEXT NOT NULL,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (chain_id, collection_id, feature_key),
  FOREIGN KEY(collection_id) REFERENCES collections(collection_id)
);

CREATE INDEX IF NOT EXISTS collection_customization_features_collection_idx
  ON collection_customization_features (chain_id, collection_id);
