-- Old fills lack complete execution items and cannot populate the new model.
-- Retire all sale history atomically; ordinary backfill rebuilds it from receipts.
-- Transfer facts, current balances, collection coverage and other activities stay.
DELETE FROM activities WHERE kind = 'sale';
DROP TABLE fills;

CREATE TABLE fill_executions (
  id TEXT PRIMARY KEY,
  chain_id INTEGER NOT NULL,
  kind TEXT NOT NULL,
  protocol_address TEXT NOT NULL,
  tx_hash TEXT NOT NULL,
  log_index INTEGER NOT NULL,
  block_number INTEGER NOT NULL,
  block_hash TEXT NOT NULL,
  block_timestamp INTEGER NOT NULL,
  price_exclusion TEXT,
  total_price TEXT,
  currency TEXT,
  nft_quantity TEXT NOT NULL,
  UNIQUE (chain_id, kind, tx_hash, log_index),
  CHECK ((price_exclusion IS NULL AND total_price IS NOT NULL AND currency IS NOT NULL)
      OR (price_exclusion IS NOT NULL AND total_price IS NULL AND currency IS NULL))
);
CREATE INDEX fill_executions_block_idx ON fill_executions (chain_id, block_number);

CREATE TABLE fill_execution_items (
  execution_id TEXT NOT NULL REFERENCES fill_executions(id) ON DELETE CASCADE,
  item_index INTEGER NOT NULL,
  side TEXT NOT NULL CHECK (side IN ('offer', 'consideration')),
  item_type INTEGER NOT NULL,
  contract_address TEXT NOT NULL,
  identifier TEXT NOT NULL,
  amount TEXT NOT NULL,
  recipient TEXT,
  -- Prefix NFT quantity in protocol item order, including all untracked items.
  unit_offset TEXT NOT NULL,
  PRIMARY KEY (execution_id, item_index)
) WITHOUT ROWID;

CREATE TABLE fills (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  chain_id INTEGER NOT NULL,
  collection_id INTEGER NOT NULL,
  execution_id TEXT NOT NULL,
  item_index INTEGER NOT NULL,
  kind TEXT NOT NULL,
  order_id TEXT,
  order_side TEXT,
  maker TEXT,
  taker TEXT,
  contract_address TEXT NOT NULL,
  token_id TEXT NOT NULL,
  amount TEXT NOT NULL,
  block_number INTEGER NOT NULL,
  block_hash TEXT NOT NULL,
  block_timestamp INTEGER NOT NULL,
  tx_hash TEXT NOT NULL,
  log_index INTEGER NOT NULL,
  FOREIGN KEY (execution_id, item_index) REFERENCES fill_execution_items(execution_id, item_index) ON DELETE CASCADE,
  UNIQUE (collection_id, execution_id, item_index)
);
CREATE INDEX fills_execution_idx ON fills (execution_id, item_index);
CREATE INDEX fills_collection_time_idx ON fills (chain_id, collection_id, block_timestamp, block_number, log_index);
CREATE INDEX fills_collection_token_idx ON fills (chain_id, collection_id, token_id, block_timestamp, block_number, log_index);
CREATE INDEX fills_contract_token_idx ON fills (chain_id, contract_address, token_id);
CREATE INDEX fills_maker_idx ON fills (chain_id, maker);
CREATE INDEX fills_taker_idx ON fills (chain_id, taker);
CREATE INDEX fills_tx_idx ON fills (chain_id, tx_hash);
