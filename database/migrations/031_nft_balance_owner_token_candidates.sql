CREATE INDEX IF NOT EXISTS nft_balances_collection_owner_tokens_idx
  ON nft_balances (
    chain_id,
    collection_id,
    owner,
    token_id,
    amount
  );
