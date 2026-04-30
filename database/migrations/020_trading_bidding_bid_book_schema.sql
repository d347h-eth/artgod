CREATE TABLE IF NOT EXISTS trading_bidding_bid_book_rows (
  chain_id INTEGER NOT NULL,
  collection_id INTEGER NOT NULL,
  order_id TEXT NOT NULL,
  source TEXT NOT NULL,
  scope_kind TEXT NOT NULL,
  scope_label TEXT NOT NULL,
  token_id TEXT,
  scope_traits_json TEXT NOT NULL DEFAULT '[]',
  encoded_token_ids TEXT,
  maker TEXT NOT NULL,
  is_own INTEGER NOT NULL DEFAULT 0,
  price_wei TEXT NOT NULL,
  currency_address TEXT,
  currency_symbol TEXT,
  protocol_address TEXT,
  valid_until INTEGER,
  snapshot_refreshed_at_ms INTEGER,
  seen_at TEXT DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (chain_id, collection_id, source, order_id),
  FOREIGN KEY(collection_id) REFERENCES collections(collection_id) ON DELETE CASCADE,
  CHECK (source IN ('bot_snapshot', 'orders')),
  CHECK (scope_kind IN ('collection', 'trait', 'token', 'token_set', 'unknown')),
  CHECK (is_own IN (0, 1)),
  CHECK (price_wei != '')
);

CREATE INDEX IF NOT EXISTS trading_bidding_bid_book_collection_scope_idx
  ON trading_bidding_bid_book_rows (chain_id, collection_id, source, scope_kind);

CREATE INDEX IF NOT EXISTS trading_bidding_bid_book_token_idx
  ON trading_bidding_bid_book_rows (chain_id, collection_id, source, token_id)
  WHERE token_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS trading_bidding_bid_book_maker_idx
  ON trading_bidding_bid_book_rows (chain_id, collection_id, maker);

CREATE TABLE IF NOT EXISTS trading_bidding_collection_bid_book_state (
  chain_id INTEGER NOT NULL,
  collection_id INTEGER NOT NULL,
  source TEXT NOT NULL,
  snapshot_refreshed_at_ms INTEGER,
  projected_at TEXT,
  row_count INTEGER NOT NULL DEFAULT 0,
  duration_ms INTEGER,
  last_error TEXT,
  PRIMARY KEY (chain_id, collection_id, source),
  FOREIGN KEY(collection_id) REFERENCES collections(collection_id) ON DELETE CASCADE,
  CHECK (source IN ('bot_snapshot', 'orders')),
  CHECK (row_count >= 0)
);
