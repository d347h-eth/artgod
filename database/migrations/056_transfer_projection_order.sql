-- Late gap repairs project each ERC721 token from its latest persisted transfer.
CREATE INDEX IF NOT EXISTS nft_transfer_events_projection_order_idx
  ON nft_transfer_events (chain_id, collection_id, token_id, block_number DESC, log_index DESC);
