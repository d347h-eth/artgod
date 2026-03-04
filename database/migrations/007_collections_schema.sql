-- Collection registry and bootstrap state
CREATE TABLE IF NOT EXISTS collections (
  collection_id INTEGER PRIMARY KEY AUTOINCREMENT,
  chain_id INTEGER NOT NULL,
  slug TEXT,
  address TEXT NOT NULL,
  standard TEXT NOT NULL,
  status TEXT NOT NULL,
  deployment_block INTEGER,
  bootstrap_anchor_block INTEGER,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT DEFAULT CURRENT_TIMESTAMP
);

CREATE UNIQUE INDEX IF NOT EXISTS collections_chain_address_uq
  ON collections (chain_id, address);

CREATE UNIQUE INDEX IF NOT EXISTS collections_chain_slug_uq
  ON collections (chain_id, slug);

CREATE INDEX IF NOT EXISTS collections_status_idx
  ON collections (chain_id, status);

CREATE INDEX IF NOT EXISTS collections_chain_created_at_idx
  ON collections (chain_id, created_at DESC, address ASC);
