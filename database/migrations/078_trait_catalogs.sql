-- Only installed extensions which declare a trait catalog create these rows.
-- The revision clock survives token rollback. Generation IDs never repeat across a purge.
CREATE TABLE trait_catalog_clocks (
  chain_id INTEGER NOT NULL,
  collection_id INTEGER NOT NULL,
  revision INTEGER NOT NULL,
  PRIMARY KEY (chain_id, collection_id),
  FOREIGN KEY (chain_id, collection_id) REFERENCES collection_extension_installs ON DELETE CASCADE
);

CREATE TABLE trait_catalog_views (
  chain_id INTEGER NOT NULL,
  collection_id INTEGER NOT NULL,
  view_id TEXT NOT NULL,
  descriptor_json TEXT NOT NULL,
  active_generation INTEGER,
  PRIMARY KEY (chain_id, collection_id, view_id),
  FOREIGN KEY (chain_id, collection_id) REFERENCES collection_extension_installs ON DELETE CASCADE
);

CREATE TABLE trait_catalog_generations (
  generation INTEGER PRIMARY KEY AUTOINCREMENT,
  chain_id INTEGER NOT NULL,
  collection_id INTEGER NOT NULL,
  view_id TEXT NOT NULL,
  mapper_version TEXT NOT NULL,
  cleanup_pending INTEGER NOT NULL DEFAULT 0,
  UNIQUE (chain_id, collection_id, view_id, generation),
  FOREIGN KEY (chain_id, collection_id, view_id) REFERENCES trait_catalog_views ON DELETE CASCADE
);

CREATE INDEX trait_catalog_retired ON trait_catalog_generations(chain_id, generation) WHERE cleanup_pending=1;

CREATE TABLE trait_catalog_members (
  chain_id INTEGER NOT NULL,
  collection_id INTEGER NOT NULL,
  token_id TEXT NOT NULL,
  revision INTEGER NOT NULL,
  view_id TEXT,
  scope_key TEXT,
  canonical_count INTEGER NOT NULL DEFAULT 0 CHECK(canonical_count >= 0),
  classification_error TEXT,
  retry_at INTEGER,
  PRIMARY KEY (chain_id, collection_id, token_id),
  UNIQUE (chain_id, collection_id, view_id, token_id, revision),
  FOREIGN KEY (chain_id, collection_id) REFERENCES collection_extension_installs ON DELETE CASCADE,
  FOREIGN KEY (chain_id, collection_id, token_id) REFERENCES token_metadata ON DELETE CASCADE,
  FOREIGN KEY (chain_id, collection_id, view_id) REFERENCES trait_catalog_views ON DELETE CASCADE
);
CREATE INDEX trait_catalog_classify_due ON trait_catalog_members(chain_id,retry_at) WHERE retry_at IS NOT NULL;

CREATE TABLE trait_catalog_projections (
  chain_id INTEGER NOT NULL,
  collection_id INTEGER NOT NULL,
  view_id TEXT NOT NULL,
  generation INTEGER NOT NULL,
  token_id TEXT NOT NULL,
  revision INTEGER NOT NULL,
  tree_json TEXT NOT NULL,
  PRIMARY KEY (chain_id, collection_id, view_id, generation, token_id),
  FOREIGN KEY (chain_id, collection_id, view_id, generation)
    REFERENCES trait_catalog_generations(chain_id, collection_id, view_id, generation) ON DELETE CASCADE,
  FOREIGN KEY (chain_id, collection_id, view_id, token_id, revision)
    REFERENCES trait_catalog_members(chain_id, collection_id, view_id, token_id, revision) ON DELETE CASCADE
);
CREATE INDEX trait_catalog_projections_source ON trait_catalog_projections(chain_id,collection_id,view_id,token_id,revision);

-- Flat filterable leaves. Preserve the exact native pair independently of labels/field IDs.
CREATE TABLE trait_catalog_values (
  chain_id INTEGER NOT NULL,
  collection_id INTEGER NOT NULL,
  view_id TEXT NOT NULL,
  generation INTEGER NOT NULL,
  token_id TEXT NOT NULL,
  field_id TEXT NOT NULL,
  label TEXT NOT NULL,
  value TEXT NOT NULL,
  native_field_key TEXT,
  native_key TEXT,
  native_value TEXT,
  PRIMARY KEY (chain_id, collection_id, view_id, generation, token_id, field_id, value),
  FOREIGN KEY (chain_id, collection_id, view_id, generation, token_id)
    REFERENCES trait_catalog_projections ON DELETE CASCADE
);
CREATE INDEX trait_catalog_filter ON trait_catalog_values(chain_id,collection_id,view_id,generation,field_id,value,token_id);

CREATE TABLE trait_catalog_work (
  chain_id INTEGER NOT NULL,
  collection_id INTEGER NOT NULL,
  view_id TEXT NOT NULL,
  generation INTEGER NOT NULL,
  token_id TEXT NOT NULL,
  revision INTEGER NOT NULL,
  lease_owner TEXT,
  due_at INTEGER DEFAULT 0,
  error TEXT,
  PRIMARY KEY (generation,token_id),
  FOREIGN KEY (chain_id, collection_id, view_id, generation)
    REFERENCES trait_catalog_generations(chain_id, collection_id, view_id, generation) ON DELETE CASCADE,
  FOREIGN KEY (chain_id, collection_id, view_id, token_id, revision)
    REFERENCES trait_catalog_members(chain_id, collection_id, view_id, token_id, revision) ON DELETE CASCADE
);
CREATE INDEX trait_catalog_work_due ON trait_catalog_work(chain_id,due_at);
CREATE INDEX trait_catalog_work_source ON trait_catalog_work(chain_id,collection_id,view_id,token_id,revision);

-- The target generation is also the durable run ID. Completed runs retain their final totals.
CREATE TABLE trait_catalog_rebuilds (
  generation INTEGER PRIMARY KEY,
  chain_id INTEGER NOT NULL,
  collection_id INTEGER NOT NULL,
  view_id TEXT NOT NULL,
  cursor TEXT NOT NULL DEFAULT '',
  enumerated INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL,
  error TEXT,
  final_total INTEGER,
  FOREIGN KEY (chain_id, collection_id, view_id, generation)
    REFERENCES trait_catalog_generations(chain_id, collection_id, view_id, generation) ON DELETE CASCADE
);
CREATE INDEX trait_catalog_rebuild_poll ON trait_catalog_rebuilds(chain_id,status,generation);
CREATE UNIQUE INDEX trait_catalog_running ON trait_catalog_rebuilds(chain_id,collection_id,view_id) WHERE status='running';

-- A reorg deletes attributed token_metadata. Native and derived consumers must
-- both stop seeing the removed observation. Additive extension links have their own owner.
CREATE TRIGGER trait_catalog_delete_canonical AFTER DELETE ON token_metadata BEGIN
  DELETE FROM token_attributes WHERE chain_id=OLD.chain_id AND collection_id=OLD.collection_id
    AND token_id=OLD.token_id AND source_kind='metadata' AND source_key='canonical';
END;


-- Replacing an installation cannot hand its old mapper leases or view descriptors
-- to a different extension. Temporarily disabling the same install can resume its work.
CREATE TRIGGER trait_catalog_replace_install AFTER UPDATE OF extension_key ON collection_extension_installs
WHEN NEW.extension_key <> OLD.extension_key BEGIN
  DELETE FROM trait_catalog_members WHERE chain_id=OLD.chain_id AND collection_id=OLD.collection_id;
  DELETE FROM trait_catalog_views WHERE chain_id=OLD.chain_id AND collection_id=OLD.collection_id;
END;
