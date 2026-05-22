-- Per-collection block sync coverage used by blockspace visibility and bootstrap completion checks.
CREATE TABLE IF NOT EXISTS collection_sync_blocks (
  chain_id INTEGER NOT NULL,
  collection_id INTEGER NOT NULL,
  block_number INTEGER NOT NULL,
  first_synced_at TEXT DEFAULT CURRENT_TIMESTAMP,
  last_synced_at TEXT DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (chain_id, collection_id, block_number),
  FOREIGN KEY(collection_id) REFERENCES collections(collection_id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS collection_sync_blocks_range_idx
  ON collection_sync_blocks (chain_id, collection_id, block_number);
