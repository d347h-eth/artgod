-- Find the highest retained block before applying retry eligibility. Older
-- history waits when that height is retrying or ahead of an RPC provider.
CREATE INDEX collection_sync_gap_scans_newest_idx
  ON collection_sync_gap_scans (chain_id, pending_to_block DESC, retry_at, collection_id)
  WHERE pending_job_id IS NOT NULL;

DROP INDEX collection_sync_gap_scans_due_idx;
