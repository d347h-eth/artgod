-- One resumable coverage sweep and at most one outstanding repair per collection.
-- A repair is completed only after the sync worker publishes downstream work.
CREATE TABLE IF NOT EXISTS collection_sync_gap_scans (
  chain_id INTEGER NOT NULL,
  collection_id INTEGER NOT NULL,
  anchor_block INTEGER NOT NULL CHECK (anchor_block >= 1),
  cursor_block INTEGER,
  pending_job_id TEXT,
  pending_from_block INTEGER,
  pending_to_block INTEGER,
  retry_at INTEGER,
  PRIMARY KEY (chain_id, collection_id),
  FOREIGN KEY (collection_id) REFERENCES collections(collection_id) ON DELETE CASCADE,
  CHECK (cursor_block IS NULL OR cursor_block >= anchor_block),
  CHECK (
    (pending_job_id IS NULL AND pending_from_block IS NULL AND pending_to_block IS NULL AND retry_at IS NULL)
    OR
    (pending_job_id IS NOT NULL AND pending_from_block IS NOT NULL AND pending_to_block IS NOT NULL AND retry_at IS NOT NULL
      AND pending_from_block >= anchor_block AND pending_to_block >= pending_from_block)
  )
);
