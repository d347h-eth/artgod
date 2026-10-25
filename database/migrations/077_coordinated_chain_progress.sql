-- Applied progress is new evidence. Never infer it from previously sparse headers.
CREATE TABLE chain_sync_progress (
    chain_id INTEGER PRIMARY KEY,
    revision INTEGER NOT NULL CHECK (revision >= 0),
    anchor_block INTEGER NOT NULL CHECK (anchor_block >= 0),
    anchor_hash TEXT NOT NULL,
    applied_block INTEGER NOT NULL CHECK (applied_block >= anchor_block),
    applied_hash TEXT NOT NULL,
    disputed_from INTEGER CHECK (disputed_from >= 0)
);

-- The bootstrap installer records its base before the coordinator accepts it.
-- Selecting an anchor is not proof that its ownership snapshot was installed.
CREATE TABLE collection_ownership_bases (
    chain_id INTEGER NOT NULL,
    collection_id INTEGER NOT NULL REFERENCES collections(collection_id) ON DELETE CASCADE,
    run_id INTEGER NOT NULL,
    revision INTEGER NOT NULL CHECK (revision >= 0),
    anchor_block INTEGER NOT NULL CHECK (anchor_block >= 0),
    anchor_hash TEXT NOT NULL,
    PRIMARY KEY (chain_id, collection_id)
);

CREATE TABLE collection_sync_progress (
    chain_id INTEGER NOT NULL,
    collection_id INTEGER NOT NULL REFERENCES collections(collection_id) ON DELETE CASCADE,
    revision INTEGER NOT NULL CHECK (revision >= 0),
    anchor_block INTEGER NOT NULL CHECK (anchor_block >= 0),
    anchor_hash TEXT NOT NULL,
    applied_block INTEGER NOT NULL CHECK (applied_block >= anchor_block),
    applied_hash TEXT NOT NULL,
    PRIMARY KEY (chain_id, collection_id)
);
CREATE INDEX collection_sync_progress_next ON collection_sync_progress(chain_id, applied_block, collection_id);

ALTER TABLE chain_sync_revisions ADD COLUMN admission_sequence INTEGER NOT NULL DEFAULT 0 CHECK (admission_sequence >= 0);

-- One compact barrier per successful admission watermark, not one RPC per order.
-- These are remote observations, never canonical membership or applied progress.
CREATE TABLE chain_head_samples (
    chain_id INTEGER NOT NULL,
    revision INTEGER NOT NULL CHECK (revision >= 0),
    admission_watermark INTEGER NOT NULL CHECK (admission_watermark >= 0),
    block_number INTEGER NOT NULL CHECK (block_number >= 0),
    block_hash TEXT NOT NULL,
    sampled_at INTEGER NOT NULL,
    PRIMARY KEY (chain_id, revision, admission_watermark)
);

CREATE TABLE chain_sync_targets (
    chain_id INTEGER PRIMARY KEY,
    revision INTEGER NOT NULL CHECK (revision >= 0),
    block_number INTEGER NOT NULL CHECK (block_number >= 0),
    block_hash TEXT NOT NULL,
    sampled_at INTEGER NOT NULL
);
