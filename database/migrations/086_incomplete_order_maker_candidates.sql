-- Invalidation includes incomplete observed declarations. Their ordinary demand
-- waits for signed terms without dropping the maker scope's obligation.
DROP INDEX IF EXISTS orders_maker_revalidation_candidates_idx;
CREATE INDEX orders_maker_revalidation_candidates_idx
  ON orders(chain_id,maker,source_status,id) WHERE kind='seaport';
DROP INDEX IF EXISTS orders_maker_collection_revalidation_idx;
CREATE INDEX orders_maker_collection_revalidation_idx
  ON orders(chain_id,maker,collection_id,source_status,id) WHERE kind='seaport' AND side='sell';
