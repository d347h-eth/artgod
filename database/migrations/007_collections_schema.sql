-- Collection registry and bootstrap state
CREATE TABLE IF NOT EXISTS collections (
  collection_id INTEGER PRIMARY KEY AUTOINCREMENT,
  chain_id INTEGER NOT NULL,
  slug TEXT NOT NULL,
  address TEXT NOT NULL,
  standard TEXT NOT NULL,
  status TEXT NOT NULL,
  token_scope_kind TEXT NOT NULL,
  scope_start_token_id TEXT,
  scope_total_supply INTEGER,
  deployment_block INTEGER,
  bootstrap_anchor_block INTEGER,
  bootstrap_started_at TEXT,
  bootstrap_finished_at TEXT,
  bootstrap_last_synced_block INTEGER,
  opensea_slug TEXT,
  opensea_status TEXT,
  opensea_ready_at TEXT,
  opensea_snapshot_started_at TEXT,
  opensea_snapshot_completed_at TEXT,
  opensea_reconcile_started_at TEXT,
  opensea_reconcile_completed_at TEXT,
  opensea_last_stream_event_at TEXT,
  opensea_last_stream_healthy_at TEXT,
  opensea_last_error TEXT,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT DEFAULT CURRENT_TIMESTAMP,
  CHECK (
    (token_scope_kind = 'contract_all_tokens' AND scope_start_token_id IS NULL AND scope_total_supply IS NULL)
    OR (token_scope_kind = 'token_range' AND scope_start_token_id IS NOT NULL AND scope_total_supply IS NOT NULL AND scope_total_supply > 0)
    OR (token_scope_kind = 'explicit_token_ids' AND scope_start_token_id IS NULL AND scope_total_supply IS NULL)
  )
);

CREATE UNIQUE INDEX IF NOT EXISTS collections_chain_slug_uq
  ON collections (chain_id, slug);

CREATE UNIQUE INDEX IF NOT EXISTS collections_chain_opensea_slug_uq
  ON collections (chain_id, opensea_slug)
  WHERE opensea_slug IS NOT NULL;

CREATE INDEX IF NOT EXISTS collections_chain_address_idx
  ON collections (chain_id, address);

CREATE INDEX IF NOT EXISTS collections_status_idx
  ON collections (chain_id, status);

CREATE INDEX IF NOT EXISTS collections_chain_created_at_idx
  ON collections (chain_id, created_at DESC, slug ASC);

CREATE TABLE IF NOT EXISTS collection_scope_tokens (
  chain_id INTEGER NOT NULL,
  collection_id INTEGER NOT NULL,
  token_id TEXT NOT NULL,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (chain_id, collection_id, token_id),
  FOREIGN KEY(collection_id) REFERENCES collections(collection_id)
);

CREATE INDEX IF NOT EXISTS collection_scope_tokens_token_idx
  ON collection_scope_tokens (chain_id, token_id);
