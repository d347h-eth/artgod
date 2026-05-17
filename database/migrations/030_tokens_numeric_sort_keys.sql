ALTER TABLE tokens ADD COLUMN token_sort_bucket INTEGER GENERATED ALWAYS AS (
  CASE WHEN token_id <> '' AND token_id NOT GLOB '*[^0-9]*' THEN 0 ELSE 1 END
) VIRTUAL;

ALTER TABLE tokens ADD COLUMN token_sort_length INTEGER GENERATED ALWAYS AS (
  CASE WHEN token_id <> '' AND token_id NOT GLOB '*[^0-9]*'
    THEN LENGTH(CASE WHEN LTRIM(token_id, '0') = '' THEN '0' ELSE LTRIM(token_id, '0') END)
    ELSE 0
  END
) VIRTUAL;

ALTER TABLE tokens ADD COLUMN token_sort_value TEXT GENERATED ALWAYS AS (
  CASE WHEN token_id <> '' AND token_id NOT GLOB '*[^0-9]*'
    THEN CASE WHEN LTRIM(token_id, '0') = '' THEN '0' ELSE LTRIM(token_id, '0') END
    ELSE token_id
  END
) VIRTUAL;

CREATE INDEX IF NOT EXISTS tokens_collection_numeric_sort_idx
  ON tokens (
    chain_id,
    collection_id,
    token_sort_bucket,
    token_sort_length,
    token_sort_value,
    token_id
  );
