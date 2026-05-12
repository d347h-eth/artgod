CREATE TABLE IF NOT EXISTS trading_bidding_price_tiers (
  tier_id TEXT PRIMARY KEY,
  chain_id INTEGER NOT NULL,
  collection_id INTEGER NOT NULL,
  name TEXT NOT NULL,
  status TEXT NOT NULL,
  sort_order INTEGER NOT NULL,
  parent_tier_id TEXT,
  floor_config_json TEXT NOT NULL,
  ceiling_config_json TEXT NOT NULL,
  resolved_floor_wei TEXT,
  resolved_ceiling_wei TEXT,
  resolved_at TEXT,
  last_error TEXT,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT DEFAULT CURRENT_TIMESTAMP,
  archived_at TEXT,
  revision INTEGER NOT NULL DEFAULT 1,
  FOREIGN KEY(collection_id) REFERENCES collections(collection_id) ON DELETE CASCADE,
  FOREIGN KEY(parent_tier_id) REFERENCES trading_bidding_price_tiers(tier_id),
  CHECK (status IN ('enabled', 'paused', 'archived')),
  CHECK (revision > 0),
  CHECK (name != ''),
  CHECK (floor_config_json != ''),
  CHECK (ceiling_config_json != '')
);

CREATE INDEX IF NOT EXISTS trading_bidding_price_tiers_collection_idx
  ON trading_bidding_price_tiers (chain_id, collection_id, status, sort_order ASC, tier_id ASC);

CREATE INDEX IF NOT EXISTS trading_bidding_price_tiers_parent_idx
  ON trading_bidding_price_tiers (parent_tier_id)
  WHERE parent_tier_id IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS trading_bidding_price_tiers_one_child_uq
  ON trading_bidding_price_tiers (parent_tier_id)
  WHERE parent_tier_id IS NOT NULL AND status != 'archived';
