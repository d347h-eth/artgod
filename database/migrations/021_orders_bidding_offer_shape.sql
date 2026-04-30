ALTER TABLE orders ADD COLUMN quantity TEXT NOT NULL DEFAULT '1';
ALTER TABLE orders ADD COLUMN source_encoded_token_ids TEXT;

CREATE INDEX IF NOT EXISTS orders_active_buy_bid_book_lookup_idx
  ON orders (chain_id, collection_id, side, source_status, fillability_status, valid_from, valid_until)
  WHERE side = 'buy'
    AND price IS NOT NULL
    AND price != '';
