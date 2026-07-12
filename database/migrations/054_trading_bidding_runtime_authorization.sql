ALTER TABLE trading_bot_runtime_state
  ADD COLUMN runtime_session_id TEXT;

CREATE INDEX IF NOT EXISTS trading_bot_runtime_state_session_idx
  ON trading_bot_runtime_state (runtime_session_id);

CREATE TABLE IF NOT EXISTS trading_bidding_runtime_authorized_collections (
  runtime_session_id TEXT NOT NULL,
  chain_id INTEGER NOT NULL,
  wallet_id TEXT NOT NULL,
  collection_id INTEGER NOT NULL,
  contract_address TEXT NOT NULL,
  opensea_slug TEXT NOT NULL,
  max_unit_bid_wei TEXT NOT NULL,
  max_quantity INTEGER NOT NULL,
  published_at TEXT NOT NULL,
  PRIMARY KEY (runtime_session_id, collection_id),
  FOREIGN KEY(collection_id) REFERENCES collections(collection_id) ON DELETE CASCADE,
  CHECK (runtime_session_id != ''),
  CHECK (wallet_id != ''),
  CHECK (contract_address != ''),
  CHECK (opensea_slug != ''),
  CHECK (max_unit_bid_wei != ''),
  CHECK (max_quantity > 0)
);

CREATE INDEX IF NOT EXISTS trading_bidding_runtime_authorized_collection_lookup_idx
  ON trading_bidding_runtime_authorized_collections (
    chain_id,
    collection_id,
    runtime_session_id
  );

CREATE INDEX IF NOT EXISTS trading_bidding_runtime_authorized_collection_session_idx
  ON trading_bidding_runtime_authorized_collections (
    chain_id,
    wallet_id,
    runtime_session_id
  );
