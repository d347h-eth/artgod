-- Active sell-order candidates for collection-wide NFT approval changes.
CREATE INDEX IF NOT EXISTS orders_maker_collection_revalidation_idx
  ON orders (chain_id, maker, collection_id, source_status, fillability_status, token_id)
  WHERE kind = 'seaport'
    AND side = 'sell'
    AND seaport_data_json IS NOT NULL;
