-- Sync acquisition retains publication intent in its data transaction. Required
-- follow-ups retry independently of RPC; event hints retain their fork identity.
ALTER TABLE queue_outbox ADD COLUMN retry_policy TEXT NOT NULL DEFAULT 'bounded'
  CHECK (retry_policy IN ('bounded', 'required'));
ALTER TABLE queue_outbox ADD COLUMN sync_block_number INTEGER;
ALTER TABLE queue_outbox ADD COLUMN sync_block_hash TEXT;
CREATE INDEX queue_outbox_sync_event_idx
  ON queue_outbox (chain_id, sync_block_number)
  WHERE sync_block_number IS NOT NULL;
