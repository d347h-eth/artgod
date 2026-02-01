-- Seaport conduit cache (conduitKey -> conduit address)
CREATE TABLE IF NOT EXISTS seaport_conduits (
  chain_id INTEGER NOT NULL,
  conduit_key TEXT NOT NULL,
  conduit_address TEXT NOT NULL,
  updated_at TEXT DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (chain_id, conduit_key)
);

CREATE INDEX IF NOT EXISTS seaport_conduits_address_idx
  ON seaport_conduits (chain_id, conduit_address);
