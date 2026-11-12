-- Retain exhausted obligations without including them in automatic due-work scans.
-- Existing rows acquire a content clock only on their next incomplete response.
ALTER TABLE metadata_pending ADD COLUMN content_pending_at INTEGER;
ALTER TABLE metadata_pending ADD COLUMN exhausted_at INTEGER;

DROP INDEX metadata_pending_collection_due;
CREATE INDEX metadata_pending_collection_due
    ON metadata_pending(chain_id, collection_id, due_at, token_id)
    WHERE exhausted_at IS NULL;
