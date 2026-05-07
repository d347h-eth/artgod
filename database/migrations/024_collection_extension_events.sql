CREATE TABLE IF NOT EXISTS collection_extension_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  chain_id INTEGER NOT NULL,
  collection_id INTEGER NOT NULL,
  extension_key TEXT NOT NULL,
  event_key TEXT NOT NULL,
  contract_address TEXT NOT NULL,
  token_id TEXT NOT NULL DEFAULT '',
  maker TEXT,
  content_hash TEXT,
  block_number INTEGER NOT NULL,
  block_hash TEXT NOT NULL,
  block_timestamp INTEGER NOT NULL,
  tx_hash TEXT NOT NULL,
  log_index INTEGER NOT NULL,
  payload_json TEXT,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (
    chain_id,
    collection_id,
    extension_key,
    event_key,
    tx_hash,
    log_index,
    token_id
  )
);

CREATE INDEX IF NOT EXISTS collection_extension_events_feed_idx
  ON collection_extension_events (
    chain_id,
    collection_id,
    extension_key,
    event_key,
    block_timestamp DESC,
    id DESC
  );

CREATE INDEX IF NOT EXISTS collection_extension_events_token_idx
  ON collection_extension_events (chain_id, collection_id, token_id);

CREATE INDEX IF NOT EXISTS collection_extension_events_maker_idx
  ON collection_extension_events (chain_id, collection_id, maker);

CREATE INDEX IF NOT EXISTS collection_extension_events_hash_idx
  ON collection_extension_events (chain_id, collection_id, content_hash);

CREATE INDEX IF NOT EXISTS collection_extension_events_block_idx
  ON collection_extension_events (chain_id, block_number);
