CREATE TABLE IF NOT EXISTS activities (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  chain_id INTEGER NOT NULL,
  collection_id INTEGER NOT NULL,
  scope_kind TEXT NOT NULL,
  kind TEXT NOT NULL,
  contract_address TEXT NOT NULL,
  token_id TEXT,
  occurred_at INTEGER NOT NULL,
  source_kind TEXT NOT NULL,
  source_name TEXT NOT NULL,
  order_id TEXT,
  block_number INTEGER,
  tx_hash TEXT,
  log_index INTEGER,
  from_address TEXT,
  to_address TEXT,
  maker TEXT,
  taker TEXT,
  side TEXT,
  amount TEXT,
  price TEXT,
  currency TEXT,
  payload_json TEXT,
  dedupe_key TEXT NOT NULL,
  is_open INTEGER NOT NULL DEFAULT 0,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (chain_id, dedupe_key)
);

CREATE INDEX IF NOT EXISTS activities_collection_feed_idx
  ON activities (chain_id, collection_id, occurred_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS activities_token_feed_idx
  ON activities (chain_id, collection_id, token_id, occurred_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS activities_contract_token_idx
  ON activities (chain_id, contract_address, token_id);
CREATE INDEX IF NOT EXISTS activities_order_idx
  ON activities (chain_id, order_id);
CREATE INDEX IF NOT EXISTS activities_open_create_idx
  ON activities (
    chain_id,
    collection_id,
    contract_address,
    token_id,
    kind,
    maker,
    side,
    currency,
    is_open,
    occurred_at DESC,
    id DESC
  );

-- Maps a raw upstream source event to the projected activity row it produced.
-- This is projector bookkeeping for idempotency/coalescing, not a second
-- user-facing "activity source" model.
CREATE TABLE IF NOT EXISTS activity_sources (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  chain_id INTEGER NOT NULL,
  source_kind TEXT NOT NULL,
  source_name TEXT NOT NULL,
  source_event_key TEXT NOT NULL,
  activity_id INTEGER NOT NULL,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (chain_id, source_kind, source_name, source_event_key)
);

CREATE INDEX IF NOT EXISTS activity_sources_activity_idx
  ON activity_sources (activity_id);
