-- Coverage resets kept pre-verification headers, including mixed-fork history.
-- A broken parent link identifies suspect identities, not which side is canonical.
-- Keep both sides until fresh verification establishes which identity is orphaned.
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
  AND parent.created_at < (
    SELECT executed_at FROM migrations WHERE name = '072_pending_canonical_checks.sql'
  )
  AND parent.block_hash != child.parent_hash;

-- Published work can outlive its outbox row. Neither a broken parent link nor
-- missing SQLite references proves that a header can safely be removed.
-- Include already pending parents in discovery; preserve every pending deadline
-- while independently retaining fresh checks for unchecked children.
UPDATE blocks
SET canonical_check_pending = 1, canonical_check_retry_at = 0
WHERE canonical_check_pending = 0
  AND (chain_id, block_number) IN (
    SELECT chain_id, block_number FROM sync_header_conflicts
    UNION
    SELECT chain_id, child_block_number FROM sync_header_conflicts
  );

DROP TABLE sync_header_conflicts;
