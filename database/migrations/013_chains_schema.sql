CREATE TABLE IF NOT EXISTS chains (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  type TEXT NOT NULL,
  public_chain_id INTEGER NOT NULL,
  slug TEXT NOT NULL,
  name TEXT NOT NULL,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT DEFAULT CURRENT_TIMESTAMP
);

CREATE UNIQUE INDEX IF NOT EXISTS chains_type_public_chain_id_uq
  ON chains (type, public_chain_id);

CREATE UNIQUE INDEX IF NOT EXISTS chains_type_slug_uq
  ON chains (type, slug);

INSERT OR IGNORE INTO chains (type, public_chain_id, slug, name)
VALUES ('evm', 1, 'ethereum', 'Ethereum');
