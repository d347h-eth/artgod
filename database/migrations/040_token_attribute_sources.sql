DROP INDEX IF EXISTS token_attributes_attribute_idx;
DROP INDEX IF EXISTS token_attributes_collection_idx;

CREATE TABLE token_attributes_with_sources (
  chain_id INTEGER NOT NULL,
  collection_id INTEGER NOT NULL,
  contract_address TEXT NOT NULL,
  token_id TEXT NOT NULL,
  attribute_id INTEGER NOT NULL,
  source_kind TEXT NOT NULL,
  source_key TEXT NOT NULL,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (chain_id, collection_id, token_id, attribute_id, source_kind, source_key),
  FOREIGN KEY(attribute_id) REFERENCES attributes(id)
);

-- Mirrors TOKEN_ATTRIBUTE_SOURCE_KIND.Metadata and TOKEN_ATTRIBUTE_METADATA_SOURCE_KEY.
-- Existing normalized metadata traits become the canonical metadata source.
INSERT INTO token_attributes_with_sources (
  chain_id,
  collection_id,
  contract_address,
  token_id,
  attribute_id,
  source_kind,
  source_key,
  created_at
)
SELECT
  chain_id,
  collection_id,
  contract_address,
  token_id,
  attribute_id,
  'metadata',
  'canonical',
  created_at
FROM token_attributes;

DROP TABLE token_attributes;

ALTER TABLE token_attributes_with_sources RENAME TO token_attributes;

CREATE INDEX IF NOT EXISTS token_attributes_attribute_idx
  ON token_attributes (attribute_id);
CREATE INDEX IF NOT EXISTS token_attributes_collection_idx
  ON token_attributes (chain_id, collection_id, token_id);
CREATE INDEX IF NOT EXISTS token_attributes_source_token_idx
  ON token_attributes (chain_id, collection_id, token_id, source_kind, source_key);
