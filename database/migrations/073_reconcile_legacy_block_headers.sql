-- Coverage resets kept pre-verification headers, including mixed-fork history.
-- A broken parent link identifies suspect identities, not which side is canonical.
-- Prune only unused parent headers; retain fresh checks for every remaining side.
CREATE TEMP TABLE sync_header_conflicts AS
SELECT parent.chain_id, parent.block_number, child.block_number AS child_block_number
FROM (
  -- Automatic repair owns anchor-and-later history; older history stays manual.
  SELECT chain_id, MIN(bootstrap_anchor_block) AS anchor_block
  FROM collections WHERE bootstrap_anchor_block IS NOT NULL GROUP BY chain_id
) scope
CROSS JOIN blocks parent
CROSS JOIN blocks child
WHERE parent.chain_id = scope.chain_id
  AND parent.block_number >= scope.anchor_block
  AND child.chain_id = parent.chain_id
  AND child.block_number = parent.block_number + 1
  AND parent.canonical_check_pending = 0
  AND parent.created_at < (
    SELECT executed_at FROM migrations WHERE name = '072_pending_canonical_checks.sql'
  )
  AND parent.block_hash != child.parent_hash;

-- An identity backing facts, ownership, bootstrap or retained publication work
-- must be verified by the existing reorg owner rather than removed underneath it.
CREATE TEMP TABLE sync_headers_to_prune AS
SELECT b.chain_id, b.block_number
FROM sync_header_conflicts conflict
-- Keep reference probes bounded to the materialized suspects even with stale statistics.
CROSS JOIN blocks b
WHERE b.chain_id = conflict.chain_id AND b.block_number = conflict.block_number
  AND NOT EXISTS (
    SELECT 1 FROM transactions t
    WHERE t.chain_id = b.chain_id AND t.block_number = b.block_number
  )
  AND NOT EXISTS (
    SELECT 1 FROM nft_transfer_events t
    WHERE t.chain_id = b.chain_id AND t.block_number = b.block_number
  )
  AND NOT EXISTS (
    SELECT 1 FROM fill_executions f
    WHERE f.chain_id = b.chain_id AND f.block_number = b.block_number
  )
  AND NOT EXISTS (
    SELECT 1 FROM fills f
    WHERE f.chain_id = b.chain_id AND f.block_number = b.block_number
  )
  AND NOT EXISTS (
    SELECT 1 FROM activities a
    WHERE a.chain_id = b.chain_id AND a.block_number = b.block_number
  )
  AND NOT EXISTS (
    SELECT 1 FROM collection_extension_events e
    WHERE e.chain_id = b.chain_id AND e.block_number = b.block_number
  )
  AND NOT EXISTS (
    SELECT 1 FROM collection_extension_event_media e
    WHERE e.chain_id = b.chain_id AND e.block_number = b.block_number
  )
  AND NOT EXISTS (
    SELECT 1 FROM token_metadata m
    WHERE m.chain_id = b.chain_id AND m.block_number = b.block_number
  )
  AND NOT EXISTS (
    SELECT 1 FROM orders o
    WHERE o.chain_id = b.chain_id AND o.block_number = b.block_number
  )
  AND NOT EXISTS (
    SELECT 1 FROM market_order_retirements r
    WHERE r.chain_id = b.chain_id AND r.block_number = b.block_number
  )
  AND NOT EXISTS (
    SELECT 1 FROM nft_balances n
    WHERE n.chain_id = b.chain_id AND n.last_block_number = b.block_number
  )
  AND NOT EXISTS (
    SELECT 1 FROM erc721_ownership_checkpoints c
    WHERE c.chain_id = b.chain_id
      AND (c.block_number = b.block_number OR c.bootstrap_anchor_block = b.block_number)
  )
  AND NOT EXISTS (
    SELECT 1 FROM collections c
    WHERE c.chain_id = b.chain_id AND c.bootstrap_anchor_block = b.block_number
  )
  AND NOT EXISTS (
    SELECT 1 FROM bootstrap_runs r
    WHERE r.chain_id = b.chain_id AND r.anchor_block = b.block_number
  )
  AND NOT EXISTS (
    SELECT 1 FROM bootstrap_ownership_snapshot_tasks t
    WHERE t.chain_id = b.chain_id AND t.anchor_block = b.block_number
  )
  AND NOT EXISTS (
    SELECT 1 FROM bootstrap_metadata_snapshot_tasks t
    WHERE t.chain_id = b.chain_id AND t.anchor_block = b.block_number
  )
  AND NOT EXISTS (
    SELECT 1 FROM queue_outbox q
    WHERE q.chain_id = b.chain_id
      AND (q.sync_block_number = b.block_number OR
        CASE WHEN json_valid(q.job_json)
          THEN json_extract(q.job_json, '$.onchainBlock.blockNumber')
          ELSE b.block_number
        END = b.block_number)
  )
  AND NOT EXISTS (
    SELECT 1 FROM chain_reorg_recoveries r WHERE r.chain_id = b.chain_id
  );

-- Preserve already pending checks and their backoff. A canonical child may
-- agree with RPC; checking both sides also covers a bad child of a good parent.
UPDATE blocks
SET canonical_check_pending = 1, canonical_check_retry_at = 0
WHERE canonical_check_pending = 0
  AND (chain_id, block_number) IN (
    SELECT chain_id, block_number FROM sync_header_conflicts
    UNION
    SELECT chain_id, child_block_number FROM sync_header_conflicts
  )
  AND (chain_id, block_number) NOT IN (
    SELECT chain_id, block_number FROM sync_headers_to_prune
  );

-- Fence RPC work captured before this cleanup, without changing other chains.
INSERT INTO chain_sync_revisions (chain_id, revision)
SELECT DISTINCT chain_id, 1 FROM sync_headers_to_prune WHERE true
ON CONFLICT (chain_id) DO UPDATE SET revision = revision + 1;

-- Coverage at a removed identity must become a gap so its canonical data is
-- fetched again. Seek the existing collection primary key instead of scanning
-- all historical coverage for each suspect header.
DELETE FROM collection_sync_blocks
WHERE (chain_id, collection_id, block_number) IN (
  SELECT p.chain_id, c.collection_id, p.block_number
  FROM sync_headers_to_prune p JOIN collections c ON c.chain_id = p.chain_id
);

DELETE FROM blocks
WHERE (chain_id, block_number) IN (
  SELECT chain_id, block_number FROM sync_headers_to_prune
);

DROP TABLE sync_headers_to_prune;
DROP TABLE sync_header_conflicts;
