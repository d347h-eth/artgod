-- Rollback invalidates RPC work fetched against an earlier local chain revision.
CREATE TABLE IF NOT EXISTS chain_sync_revisions (
  chain_id INTEGER PRIMARY KEY,
  revision INTEGER NOT NULL CHECK (revision >= 0)
);

-- Keep verified end-of-block ownership, including absent tokens, so historical
-- gap repairs and later rollbacks do not rely on an incomplete transfer history.
CREATE TABLE IF NOT EXISTS erc721_ownership_checkpoints (
  chain_id INTEGER NOT NULL,
  collection_id INTEGER NOT NULL,
  contract_address TEXT NOT NULL,
  token_id TEXT NOT NULL,
  owner TEXT CHECK (owner IS NULL OR owner = lower(owner)),
  block_number INTEGER NOT NULL CHECK (block_number >= 0),
  block_hash TEXT NOT NULL,
  block_timestamp INTEGER NOT NULL,
  bootstrap_anchor_block INTEGER,
  PRIMARY KEY (chain_id, collection_id, token_id),
  FOREIGN KEY (collection_id) REFERENCES collections(collection_id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS erc721_ownership_checkpoint_block_idx
  ON erc721_ownership_checkpoints (chain_id, block_number);
CREATE INDEX IF NOT EXISTS nft_transfer_events_block_idx
  ON nft_transfer_events (chain_id, block_number DESC, log_index DESC);
CREATE INDEX IF NOT EXISTS nft_balances_block_idx
  ON nft_balances (chain_id, last_block_number);
