ALTER TABLE trading_bidding_bid_book_rows
  ADD COLUMN quantity TEXT NOT NULL DEFAULT '1';

ALTER TABLE trading_bidding_bid_book_rows
  ADD COLUMN placed_at TEXT;
