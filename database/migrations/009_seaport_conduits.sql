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

CREATE TABLE IF NOT EXISTS seaport_conduit_channels (
  chain_id INTEGER NOT NULL,
  conduit_address TEXT NOT NULL,
  channel_address TEXT NOT NULL,
  updated_at TEXT DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (chain_id, conduit_address, channel_address)
);

CREATE INDEX IF NOT EXISTS seaport_conduit_channels_conduit_idx
  ON seaport_conduit_channels (chain_id, conduit_address);
