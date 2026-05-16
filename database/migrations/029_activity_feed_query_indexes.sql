-- Feed-shaped indexes for public activity API filters.
CREATE INDEX IF NOT EXISTS activities_collection_kind_feed_idx
  ON activities (chain_id, collection_id, kind, occurred_at DESC, id DESC);

CREATE INDEX IF NOT EXISTS activities_collection_extension_event_feed_idx
  ON activities (
    chain_id,
    collection_id,
    kind,
    source_kind,
    source_name,
    json_extract(payload_json, '$.eventKey'),
    occurred_at DESC,
    id DESC
  );

CREATE INDEX IF NOT EXISTS activities_collection_maker_feed_idx
  ON activities (chain_id, collection_id, maker, occurred_at DESC, id DESC)
  WHERE maker IS NOT NULL;

CREATE INDEX IF NOT EXISTS activities_collection_content_hash_feed_idx
  ON activities (
    chain_id,
    collection_id,
    LOWER(COALESCE(json_extract(payload_json, '$.contentHash'), '')),
    occurred_at DESC,
    id DESC
  );

CREATE INDEX IF NOT EXISTS activities_collection_event_group_feed_idx
  ON activities (
    chain_id,
    collection_id,
    LOWER(COALESCE(json_extract(payload_json, '$.eventGroup'), '')),
    occurred_at DESC,
    id DESC
  );
