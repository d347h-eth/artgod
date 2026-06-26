# Collection Bootstrap

This document describes the implemented per-collection bootstrap flow.

The goal is to reach a correct local ownership state quickly and then attach OpenSea orderbook tracking without blocking core onchain correctness.

## Why Bootstrap Exists

`nft_balances` is the canonical current ownership table, but it is only correct when:

1. we have a snapshot anchored to a specific block, and
2. we have processed every transfer after that block with no gaps

Full backfill from genesis also works, but it is too expensive for the normal local-first path.

Historical backfill before the anchor is still useful, but only as fact import:

- it can enrich `nft_transfer_events`, `fills`, and downstream historical activity
- it must not mutate `nft_balances` or other current-state/materialized tables

## Current Lifecycle

Each collection starts outside the indexed set. When the user adds a collection, the bootstrap worker runs a deterministic pipeline.

### 1. Register collection

- persist collection config in `collections`
- set `status = bootstrapping`
- create a bootstrap run
- enqueue `bootstrap.collection.start`

### 2. Pick anchor block

- choose `head - reorgDepth`
- persist `bootstrap_anchor_block`
- this block becomes the ownership truth point for snapshotting

### 3. Auto-install embedded collection extension

During bootstrap run creation, the system checks whether the requested collection contract plus token scope exactly matches a known embedded extension definition. If it does, the run stores the requested extension key. During bootstrap start, the worker installs that requested extension onto the resolved `collection_id`.

If it does:

- bootstrap upserts a `collection_extension_installs` row
- the install is DB-activated immediately
- later metadata writes in the same bootstrap run can already fan out extension artifact refresh jobs

Current v1 limits:

- bootstrap only auto-installs build-bundled embedded extensions
- one extension install per collection

### 4. Metadata snapshot

- enumerate collection token ids
- fetch/store metadata first
- this step runs before OpenSea offchain work so local token/attribute context exists
- successful canonical metadata writes can publish `collection-extension.refresh-artifacts` as non-blocking side-effects
- metadata snapshot completion enqueues a canonical metadata stats checkpoint so the token browser can use standard traits before extension artifacts converge

### 5. Token image cache

When the bootstrap request enables image caching, the worker seeds a dedicated cache task for each successful metadata row with a non-empty `token_metadata.image`.

- image-cache work is published to the `collection-bootstrap-image-cache` queue
- the main bootstrap path continues to ownership/backfill/live without waiting
  for image-cache completion
- bootstrap run detail keeps image-cache progress visible from the
  `bootstrap_run_steps` journal and task counts while work is still retained
- the cache uses canonical `image`, not `animation_url`
- IPFS image refs are resolved through `COMMON_IPFS_GATEWAY_ORIGIN`
- metadata and image HTTP fetches use shared `COMMON_HTTP_FETCH_*` timeout and
  bounded retry settings
- files are written under `COMMON_MEDIA_CACHE_DIR`, or beside the SQLite DB when unset
- a configured max dimension resizes images into WebP through `sharp`
- a null max dimension stores original source bytes when possible
- failed images retry under the bootstrap retry policy and then become `failed_terminal`

The collection can continue even when some image cache tasks fail terminally. The cache is a local presentation optimization, not metadata truth.

### Collection Extension Shadow Path

Collection extensions intentionally run behind the canonical metadata snapshot rather than replacing it.

Current behavior:

- bootstrap metadata writes `token_metadata` and normalized attributes first
- bootstrap metadata snapshot completion releases canonical trait stats through the queue outbox
- extension artifact refresh is queued afterward on the dedicated collection-extension queue
- Terraforms may add extension-owned synthetic unminted-placement artifact tasks to that same queue after canonical metadata tasks are available
- metadata-derived and extension-owned collection-extension artifact tasks are seeded together in one SQLite transaction
- bootstrap does not wait for extension artifact completion before moving to image cache, ownership snapshot, or later phases
- extension artifact terminality releases a final stats recompute that includes extension-owned normalized traits

This ordering is important because:

- `token_extension_artifacts` references canonical `tokens` rows
- extension-owned synthetic token rows are published atomically with their artifact and trait writes
- retired synthetic identities are tombstoned so delayed bootstrap tasks cannot recreate them after a real mint refresh
- extension logic can depend on normalized attributes already written by the canonical metadata path
- canonical ownership correctness must not be blocked by collection-specific extras

The first embedded extension, Terraforms, uses this shadow path to cache version-2 renderer artifacts, add browseable unminted placement rows, and later drive backend media overrides.

### 6. Ownership snapshot

- seed one ownership task per token after metadata completes
- each task calls `ownerOf(tokenId)` at the anchor block through the shared
  resilient bootstrap RPC lane
- successful tasks persist snapshot rows
- task retries use the bootstrap retry policy
- ownership is mandatory: terminal ownership task failures fail the bootstrap
  run and block collection liveness
- once all ownership tasks succeed, snapshot rows finalize the base
  `nft_balances` state

### 7. Schedule short backfill

- enqueue short backfill from `anchor + 1` to current head
- bootstrap later checks block coverage before finishing the onchain bootstrap run
- the short backfill is collection-scoped
- this range is intentionally post-anchor so it can safely advance current-state tables

### 8. Schedule OpenSea bootstrap

After local metadata + ownership are available, bootstrap enqueues an OpenSea bootstrap job only when OpenSea integration is enabled and the collection has an explicit OpenSea slug.

When enabled, that OpenSea flow does:

1. read the persisted `collections.opensea_slug`
2. mark OpenSea lifecycle state pending/running for that collection
3. start the initial OpenSea orderbook snapshot
4. let the stream worker subscribe using the persisted slug when the snapshot path completes

This OpenSea work runs in parallel with the short onchain backfill.

When OpenSea is disabled (`OPENSEA_INTEGRATION_MODE=disabled` or `auto` with no `OPENSEA_API_KEY`), bootstrap records an `opensea.skipped` run event and does not mark collection OpenSea state pending. When OpenSea is enabled but no slug was configured, bootstrap also records `opensea.skipped` and continues onchain bootstrap without OpenSea work.

### 9. Mark collection `live`

When the short backfill is complete, the bootstrap worker marks the collection `status = live`.

This means:

- local ownership state is ready
- realtime onchain sync should include the collection

It does **not** mean OpenSea is necessarily ready yet.

It also does **not** mean collection-extension artifact refresh has fully converged yet. Extension artifacts are eventual side-effects and do not gate collection liveness.

### 10. Mark OpenSea offchain `ready`

The OpenSea bootstrap worker marks the collection OpenSea state `ready` after the first full snapshot succeeds.

This is tracked separately via:

- `opensea_status`
- `opensea_ready_at`
- snapshot/reconcile timestamps
- stream health timestamps

## OpenSea Reconcile Behavior

After the initial snapshot:

- live stream updates continue through the stream worker
- periodic reconcile keeps the local source-active set from drifting if stream events were missed
- reconcile scheduler also triggers an immediate run on startup for collections whose OpenSea state is stale

Current defaults:

- periodic reconcile: every 15 minutes
- stale-start threshold: 30 minutes

These are config-driven, not hardcoded business invariants.

## Correctness Guarantees

### Onchain guarantee

A collection should be considered ownership-correct once:

- metadata snapshot completed
- ownership snapshot completed
- short backfill completed
- `collections.status = live`

Token image cache completion is not part of onchain ownership correctness. It is
a local token-card loading optimization and may continue after the collection is
already live.

When a run fully succeeds and all task families have no pending, retry, or
terminal-failed rows, bootstrap removes per-token scratch rows from metadata,
ownership, image-cache, and temporary snapshot tables. `bootstrap_run_steps`
remains the historical journal for step timing and progress totals.

Manual historical backfill before `bootstrap_anchor_block` does not improve or change current ownership correctness. It only enriches historical facts before the anchor.

### OpenSea guarantee

A collection should be considered OpenSea-ready once:

- an explicit OpenSea slug was provided and persisted
- OpenSea integration is enabled
- initial snapshot succeeded
- `collections.opensea_status = ready`

Stream health is tracked separately. Stream degradation does not unset OpenSea readiness; reconcile is the recovery path.

If OpenSea integration is disabled, there is no OpenSea-ready target for bootstrap. The collection can still become onchain-live, and run-detail polling treats the OpenSea steps as out of scope.

## Eventual Consistency Note

OpenSea snapshot/reconcile completion is currently queue-publication completion, not a guarantee that every published order has already completed downstream validation.

That tradeoff is intentional for now:

- source-complete data is published quickly
- canonical order rows and validation converge through the queue pipeline shortly after

Bootstrap metadata stats follow the same availability-first shape: canonical metadata stats are published when the metadata snapshot completes, while extension-owned trait stats converge after the extension side lane finishes.

## Relevant Tables

Bootstrap and OpenSea lifecycle state is tracked primarily in:

- `collections`
- `collection_extension_installs`
- `bootstrap_runs`
- `bootstrap_run_steps`
- `bootstrap_metadata_snapshot_tasks`
- `bootstrap_ownership_snapshot_tasks`
- `nft_balance_snapshots`
- `bootstrap_image_cache_tasks`
- `token_image_cache`
- `token_extension_artifacts`
- `opensea_orderbook_runs`
- `offchain_order_observations`

## Relevant Queues and Workers

Queues:

- `collection-bootstrap`
- `collection-bootstrap-image-cache`
- `events-sync-backfill`
- `token-image-cache`
- `collection-extension-artifacts`
- `opensea-bootstrap`
- `opensea-reconcile`
- `offchain-orders-raw`

Workers:

- `bootstrap-worker`
- `sync-worker`
- `collection-extension-worker`
- `opensea-bootstrap-worker`
- `opensea-stream-worker`
- `opensea-reconcile-worker`
- `opensea-reconcile-scheduler-worker`
- `offchain-ingest-worker`
- `domain-worker`

In desktop composition, OpenSea workers are staged but not launched when the resolved OpenSea capability is disabled. In standalone dev, starting an OpenSea worker directly still fails fast unless OpenSea integration is enabled.
