ALTER TABLE orders ADD COLUMN source_scope_kind TEXT NOT NULL DEFAULT 'token';
ALTER TABLE orders ADD COLUMN source_criteria_root TEXT;
ALTER TABLE orders ADD COLUMN source_schema_json TEXT;
ALTER TABLE orders ADD COLUMN local_token_set_status TEXT NOT NULL DEFAULT 'none';
ALTER TABLE orders ADD COLUMN seaport_data_json TEXT;
ALTER TABLE orders ADD COLUMN seaport_data_source_kind TEXT;
ALTER TABLE orders ADD COLUMN raw_rest_data TEXT;
ALTER TABLE orders ADD COLUMN raw_stream_data TEXT;
ALTER TABLE orders DROP COLUMN raw_data;

CREATE INDEX IF NOT EXISTS orders_source_scope_idx
  ON orders (chain_id, source, source_scope_kind, source_status);

CREATE INDEX IF NOT EXISTS orders_local_token_set_status_idx
  ON orders (chain_id, local_token_set_status);

CREATE INDEX IF NOT EXISTS orders_seaport_data_idx
  ON orders (chain_id, kind)
  WHERE seaport_data_json IS NOT NULL;
