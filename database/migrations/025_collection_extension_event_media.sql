CREATE TABLE IF NOT EXISTS collection_extension_event_media (
  chain_id INTEGER NOT NULL,
  collection_id INTEGER NOT NULL,
  extension_key TEXT NOT NULL,
  event_key TEXT NOT NULL,
  contract_address TEXT NOT NULL,
  token_id TEXT NOT NULL DEFAULT '',
  media_ref TEXT NOT NULL,
  block_number INTEGER NOT NULL,
  block_hash TEXT NOT NULL,
  block_timestamp INTEGER NOT NULL,
  tx_hash TEXT NOT NULL,
  log_index INTEGER NOT NULL,
  image TEXT,
  animation_url TEXT,
  html_content TEXT,
  render_modes_json TEXT,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (
    chain_id,
    collection_id,
    extension_key,
    event_key,
    tx_hash,
    log_index,
    token_id,
    media_ref
  )
);

CREATE INDEX IF NOT EXISTS collection_extension_event_media_activity_idx
  ON collection_extension_event_media (
    chain_id,
    collection_id,
    extension_key,
    event_key,
    tx_hash,
    log_index,
    token_id
  );

CREATE INDEX IF NOT EXISTS collection_extension_event_media_block_idx
  ON collection_extension_event_media (chain_id, block_number);
