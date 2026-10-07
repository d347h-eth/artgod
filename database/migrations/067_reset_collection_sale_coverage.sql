-- Legacy sale retirement left collection coverage claiming complete ingestion.
-- Restart coverage sweeps from HEAD without changing anchors or current state.
-- The normal gap-repair flow rebuilds facts; pre-anchor backfill stays manual.
DELETE FROM collection_sync_blocks;
DELETE FROM collection_sync_gap_scans;
