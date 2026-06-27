-- Lease fences for concurrent collection-extension artifact workers.
ALTER TABLE bootstrap_collection_extension_artifact_tasks
  ADD COLUMN lease_owner TEXT;

ALTER TABLE bootstrap_collection_extension_artifact_tasks
  ADD COLUMN lease_until INTEGER;

CREATE INDEX IF NOT EXISTS bootstrap_collection_extension_artifact_ready_idx
  ON bootstrap_collection_extension_artifact_tasks (run_id, status, next_attempt_at, lease_until);
