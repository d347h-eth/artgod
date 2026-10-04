-- One unfinished chain recovery; queue delivery is a wakeup, not its owner.
CREATE TABLE chain_reorg_recoveries (
  chain_id INTEGER PRIMARY KEY CHECK (chain_id > 0),
  recovery_id TEXT NOT NULL,
  version INTEGER NOT NULL CHECK (version >= 0),
  revision INTEGER NOT NULL CHECK (revision >= 0),
  checked_block INTEGER NOT NULL CHECK (checked_block > 0),
  stored_hash TEXT NOT NULL,
  observed_hash TEXT NOT NULL,
  phase TEXT NOT NULL CHECK (phase IN ('awaiting_ancestor', 'resync')),
  retry_at INTEGER NOT NULL CHECK (retry_at >= 0),
  range_from INTEGER CHECK (range_from >= 1),
  range_to INTEGER CHECK (range_to >= 1),
  target_block INTEGER CHECK (target_block >= 1),
  delivery INTEGER NOT NULL DEFAULT 0 CHECK (delivery >= 0),
  last_error TEXT,
  CHECK (
    (phase = 'awaiting_ancestor' AND range_to IS NULL AND target_block IS NULL)
    OR
    (phase = 'resync' AND range_from IS NOT NULL AND range_to IS NOT NULL
     AND target_block IS NOT NULL AND range_from <= range_to AND range_to <= target_block)
  )
);
