ALTER TABLE trading_bidding_price_tiers
  ADD COLUMN delta_wei TEXT NOT NULL DEFAULT '1000000000000000';

CREATE TABLE IF NOT EXISTS collection_settings (
  chain_id INTEGER NOT NULL,
  collection_id INTEGER NOT NULL,
  setting_key TEXT NOT NULL,
  value_json TEXT NOT NULL,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (chain_id, collection_id, setting_key),
  FOREIGN KEY(collection_id) REFERENCES collections(collection_id) ON DELETE CASCADE,
  CHECK (setting_key != ''),
  CHECK (value_json != '')
);
