CREATE INDEX IF NOT EXISTS orders_maker_revalidation_candidates_idx
  ON orders (chain_id, maker, source_status, fillability_status, side, currency, collection_id, token_id)
  WHERE kind = 'seaport'
    AND seaport_data_json IS NOT NULL;
