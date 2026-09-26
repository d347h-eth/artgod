-- Keep chronological ordering in the B-tree for bounded collection/token reads.
-- The implicit rowid breaks ties after block/log order; no chart projection is stored.
DROP INDEX fills_collection_time_idx;
CREATE INDEX fills_collection_time_idx
  ON fills (chain_id, collection_id, block_timestamp, block_number, log_index);

DROP INDEX fills_collection_token_idx;
CREATE INDEX fills_collection_token_idx
  ON fills (chain_id, collection_id, token_id, block_timestamp, block_number, log_index);
