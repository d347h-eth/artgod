ALTER TABLE collections
  ADD COLUMN opensea_stream_ingestion_status TEXT NOT NULL DEFAULT 'enabled';

CREATE INDEX IF NOT EXISTS collections_opensea_stream_ingestion_idx
  ON collections (chain_id, opensea_stream_ingestion_status, status, opensea_status);
