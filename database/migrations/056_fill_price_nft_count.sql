-- Number of NFT units covered by the fill's quoted price, including untracked
-- items. NULL preserves unknown legacy executions; never infer one from the
-- number of collection-scoped rows that survived indexing.
ALTER TABLE fills ADD COLUMN price_nft_count TEXT;

CREATE INDEX fills_collection_time_idx
  ON fills (chain_id, collection_id, block_timestamp);
