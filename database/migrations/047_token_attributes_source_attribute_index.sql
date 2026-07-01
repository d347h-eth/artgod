CREATE INDEX IF NOT EXISTS token_attributes_source_attribute_idx
  ON token_attributes (chain_id, collection_id, source_kind, source_key, attribute_id);
