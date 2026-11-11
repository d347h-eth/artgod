-- Admissions/quota waits are not hosting failures and must not inflate server backoff.
ALTER TABLE metadata_pending ADD COLUMN failures INTEGER NOT NULL DEFAULT 0 CHECK (failures >= 0);
