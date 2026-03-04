-- Bootstrap metadata + ownership snapshot table
ALTER TABLE collections ADD COLUMN bootstrap_started_at TEXT;
ALTER TABLE collections ADD COLUMN bootstrap_finished_at TEXT;
ALTER TABLE collections ADD COLUMN bootstrap_last_synced_block INTEGER;

CREATE TABLE IF NOT EXISTS nft_balance_snapshots (
  run_id INTEGER NOT NULL,
  chain_id INTEGER NOT NULL,
  collection_id INTEGER NOT NULL,
  contract_address TEXT NOT NULL,
  token_id TEXT NOT NULL,
  owner TEXT NOT NULL,
  anchor_block INTEGER NOT NULL,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (run_id, token_id)
);

CREATE INDEX IF NOT EXISTS nft_balance_snapshots_collection_idx
  ON nft_balance_snapshots (chain_id, collection_id, run_id);
