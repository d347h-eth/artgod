-- Old automatic deliveries are hints after upgrade. SQLite repair/recovery rows
-- retain their unfinished ranges; the sync runtime now executes those directly.
DELETE FROM queue_outbox
WHERE job_kind = 'sync.backfill.range'
  AND json_extract(job_json, '$.payload.source') = 'reorg_recovery';
ALTER TABLE chain_reorg_recoveries DROP COLUMN delivery;
UPDATE chain_reorg_recoveries SET retry_at = 0 WHERE phase = 'resync';
UPDATE collection_sync_gap_scans SET retry_at = 0 WHERE pending_job_id IS NOT NULL;
