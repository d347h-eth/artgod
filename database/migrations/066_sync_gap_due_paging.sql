-- Keep every automatic poll bounded and seek directly past an above-head page.
CREATE INDEX collection_sync_gap_scans_due_idx
  ON collection_sync_gap_scans (chain_id, retry_at, collection_id)
  WHERE pending_job_id IS NOT NULL;
