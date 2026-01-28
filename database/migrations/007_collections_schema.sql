-- Collection registry and bootstrap state
CREATE TABLE IF NOT EXISTS collections (
  chain_id INTEGER NOT NULL,
  collection_id TEXT NOT NULL,
  address TEXT NOT NULL,
  standard TEXT NOT NULL,
  status TEXT NOT NULL,
  deployment_block INTEGER,
  bootstrap_anchor_block INTEGER,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (chain_id, collection_id)
);

CREATE UNIQUE INDEX IF NOT EXISTS collections_chain_address_uq
  ON collections (chain_id, address);

CREATE INDEX IF NOT EXISTS collections_status_idx
  ON collections (chain_id, status);
