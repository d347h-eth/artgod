-- Preset Terraforms as the first prepared collection on fresh installs.
INSERT OR IGNORE INTO collections (
  collection_id,
  chain_id,
  slug,
  address,
  standard,
  status,
  token_scope_kind,
  scope_start_token_id,
  scope_total_supply,
  deployment_block,
  bootstrap_anchor_block,
  bootstrap_started_at,
  bootstrap_finished_at,
  bootstrap_last_synced_block,
  opensea_slug,
  opensea_status
)
VALUES (
  1,
  1,
  'terraforms',
  '0x4e1f41613c9084fdb9e34e11fae9412427480e56',
  'erc721',
  'prepared',
  'contract_all_tokens',
  NULL,
  NULL,
  13823015,
  NULL,
  NULL,
  NULL,
  NULL,
  'terraforms',
  NULL
);
