-- Definitions belong to a collection inventory. Versions remain immutable so
-- editing or archiving a preset never changes a job's selected competition.
CREATE TABLE trading_bidding_competition_presets (
  preset_id TEXT PRIMARY KEY,
  chain_id INTEGER NOT NULL,
  collection_id INTEGER NOT NULL REFERENCES collections(collection_id) ON DELETE CASCADE,
  revision INTEGER NOT NULL CHECK (revision > 0),
  archived_at TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX trading_bidding_competition_presets_collection_idx
  ON trading_bidding_competition_presets (chain_id, collection_id, archived_at);

CREATE TABLE trading_bidding_competition_preset_versions (
  version_id TEXT PRIMARY KEY,
  preset_id TEXT NOT NULL REFERENCES trading_bidding_competition_presets(preset_id) ON DELETE CASCADE,
  revision INTEGER NOT NULL CHECK (revision > 0),
  target_traits_json TEXT NOT NULL CHECK (json_valid(target_traits_json) AND json_type(target_traits_json) = 'array'),
  extra_traits_json TEXT NOT NULL CHECK (json_valid(extra_traits_json) AND json_type(extra_traits_json) = 'array'),
  UNIQUE (preset_id, revision)
);

ALTER TABLE trading_bidding_job_specs
  ADD COLUMN competition_preset_version_id TEXT
  REFERENCES trading_bidding_competition_preset_versions(version_id);

CREATE INDEX trading_bidding_job_specs_competition_version_idx
  ON trading_bidding_job_specs (competition_preset_version_id)
  WHERE competition_preset_version_id IS NOT NULL;
