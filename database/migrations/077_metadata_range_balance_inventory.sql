-- Match the catalog's numeric keyset seek for known tokens without metadata yet.
-- Decoded on-chain balance IDs are normalized decimal strings, never floating-point numbers.
CREATE INDEX nft_balances_collection_numeric_token_idx
    ON nft_balances(chain_id, collection_id, length(token_id), token_id);
