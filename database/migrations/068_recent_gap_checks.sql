-- Wall-clock HEAD checks survive restarts without restarting the backward scan.
ALTER TABLE collection_sync_gap_scans ADD COLUMN last_head_check_at INTEGER
  CHECK (last_head_check_at IS NULL OR last_head_check_at >= 0);

CREATE INDEX collection_sync_gap_scans_head_check_idx
  ON collection_sync_gap_scans (chain_id, last_head_check_at, collection_id);
