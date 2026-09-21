-- Small additive schema only. Legacy-scale pruning/index replacement belongs
-- to supervised startup recovery, never one unbounded migration transaction.
ALTER TABLE orders ADD COLUMN observed_at INTEGER NOT NULL DEFAULT 0;
ALTER TABLE orders ADD COLUMN validated_at INTEGER NOT NULL DEFAULT 0;
ALTER TABLE orders ADD COLUMN protocol_address TEXT;
ALTER TABLE orders ADD COLUMN state_revision INTEGER NOT NULL DEFAULT 0;

-- Daily feed prices are historical facts, not joins to today's orderbook.
ALTER TABLE activities ADD COLUMN listing_day INTEGER;
ALTER TABLE activities ADD COLUMN listing_price_at INTEGER;

CREATE TABLE market_data_recovery (
  singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
  stage TEXT NOT NULL,
  cursor INTEGER NOT NULL DEFAULT 0,
  removed_rows INTEGER NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL DEFAULT 0
);
-- Reset legacy listing history in supervised recovery before any writer starts.
INSERT INTO market_data_recovery (singleton, stage) VALUES (1, 'listing-reset');

-- Best-effort physical shrinking is separate from logical recovery. Commit an
-- attempt before VACUUM so interruption cannot trap every subsequent startup.
CREATE TABLE market_data_compaction (
  singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
  attempted INTEGER NOT NULL DEFAULT 0,
  completed INTEGER NOT NULL DEFAULT 0
);
INSERT INTO market_data_compaction(singleton) VALUES (1);

-- Tiny source/order retirement records replace obsolete canonical payloads.
-- Expiry or reorg removes these markers; they are not a new event archive.
CREATE TABLE market_order_retirements (
  chain_id INTEGER NOT NULL,
  collection_id INTEGER NOT NULL,
  order_id TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  block_number INTEGER,
  retired_at INTEGER NOT NULL,
  reason TEXT NOT NULL,
  PRIMARY KEY (chain_id, order_id),
  FOREIGN KEY (collection_id) REFERENCES collections(collection_id) ON DELETE CASCADE
);
CREATE INDEX market_order_retirements_expiry_idx ON market_order_retirements (expires_at);
CREATE INDEX market_order_retirements_collection_idx ON market_order_retirements (chain_id, collection_id);

-- Store collection-level observation freshness once per completed reconcile,
-- without rewriting every unchanged order solely to move updated_at.
CREATE TABLE market_order_observations (
  chain_id INTEGER NOT NULL,
  collection_id INTEGER NOT NULL,
  observed_at INTEGER NOT NULL,
  PRIMARY KEY (chain_id, collection_id),
  FOREIGN KEY (collection_id) REFERENCES collections(collection_id) ON DELETE CASCADE
);

-- Fence queued/in-flight market projections against collection purge. Collection
-- IDs are AUTOINCREMENT; a removed ID is never silently reused for a new row.
CREATE TRIGGER market_orders_collection_admission BEFORE INSERT ON orders
WHEN NOT EXISTS (SELECT 1 FROM collections c WHERE c.chain_id = NEW.chain_id AND c.collection_id = NEW.collection_id)
BEGIN SELECT RAISE(IGNORE); END;
CREATE TRIGGER market_activities_collection_admission BEFORE INSERT ON activities
WHEN NOT EXISTS (SELECT 1 FROM collections c WHERE c.chain_id = NEW.chain_id AND c.collection_id = NEW.collection_id)
BEGIN SELECT RAISE(IGNORE); END;
