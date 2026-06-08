# Storage and Schema

This document describes the SQLite schema and storage adapters used by the indexer.

Primary files:

- `shared/database/db.ts`
- `shared/database/migrations.ts`
- `indexer/src/infra/storage/sqlite.ts`
- `indexer/src/infra/collections/sqlite.ts`
- `indexer/src/infra/domain/orders.ts`
- `indexer/src/infra/offchain/*.ts`
- `database/migrations/*.sql`

## SQLite Configuration

The shared database wrapper (`shared/database/db.ts`) enforces:

- DB path must be configured explicitly via `setDbPath(...)` before first DB usage.
- Runtime config loaders (`indexer/src/config/index.ts`, `backend/src/config.ts`, `indexer/src/config/opensea.ts`) read `ARTGOD_DB_PATH` and pass it into `setDbPath(...)` during startup.
- WAL journal mode for better read/write concurrency.
- `synchronous = NORMAL`.
- `foreign_keys = ON`.
- `busy_timeout = 5000`.

All code uses a single connection per process, created on demand.

## Migration Runner

Migrations are applied at runtime startup via `createMigrationRunner()`:

- ensures a `migrations` table
- executes SQL files in `database/migrations/` sorted by filename
- uses `BEGIN IMMEDIATE` to serialize migrations

The migration runner is invoked by the onchain workers and the OpenSea workers.

## Core Tables (Onchain)

Defined primarily in `database/migrations/002_indexer_schema.sql`.

### `blocks`

```sql
blocks(chain_id, block_number, block_hash, parent_hash, timestamp)
```

- Primary key: `(chain_id, block_number)`
- Used for reorg detection and persistence of canonical block metadata

### `collection_sync_blocks`

Defined in `032_collection_sync_blocks.sql`.

```sql
collection_sync_blocks(chain_id, collection_id, block_number, first_synced_at, last_synced_at)
```

- Primary key: `(chain_id, collection_id, block_number)`
- Records which collection context a sync/backfill job actually processed for each block
- Drives collection-specific sync/backfill coverage UI and collection-scoped bootstrap completion checks

### `transactions`

```sql
transactions(chain_id, tx_hash, from_address, to_address, input,
             block_number, block_hash, block_timestamp)
```

- Primary key: `(chain_id, tx_hash)`
- Stores calldata only for transactions that emitted relevant events
- Indexed by `(chain_id, block_number)` for rollback cleanup

### `nft_transfer_events`

```sql
nft_transfer_events(chain_id, collection_id, contract_address, from_address, to_address, token_id, amount,
                    block_number, block_hash, block_timestamp, tx_hash, log_index, kind)
```

- Unique constraint on `(chain_id, tx_hash, log_index, collection_id, token_id)`
- Indexed by `(chain_id, collection_id, token_id)`, `(chain_id, contract_address, token_id)`, and `(chain_id, tx_hash)`
- `amount` stored as `TEXT` to preserve integer precision

### `collection_extension_events`

```sql
collection_extension_events(chain_id, collection_id, extension_key, event_key, contract_address,
                            token_id, maker, content_hash, block_number, block_hash,
                            block_timestamp, tx_hash, log_index, payload_json)
```

- Generic immutable fact table for extension-owned onchain events
- Unique constraint on `(chain_id, collection_id, extension_key, event_key, tx_hash, log_index, token_id)`
- Indexed by feed key, token id, maker, content hash, and block number
- `payload_json` remains extension-owned; generic consumers only depend on the extension/event keys and common columns

### `nft_balances`

```sql
nft_balances(chain_id, collection_id, contract_address, token_id, owner, amount,
             last_block_number, last_block_hash, last_block_timestamp,
             last_tx_hash, last_log_index)
```

- Primary key: `(chain_id, collection_id, token_id, owner)`
- Canonical current ownership table after bootstrap completion
- Attribution columns capture the last onchain event that changed the balance
- Mutated only by forward-processing for blocks strictly greater than `collections.bootstrap_anchor_block`
- Historical backfill at or before the anchor must not rewrite this table

## Collection and Bootstrap Tables

### `tokens`

Defined in `010_token_sets_schema.sql` and extended by `030_tokens_numeric_sort_keys.sql`.

Purpose:

- stores the canonical token universe for each indexed collection
- exposes generated numeric sort columns used by backend token-browser pages

Important indexes:

- primary key on `(chain_id, collection_id, token_id)`
- unique lookup on `(chain_id, contract_address, token_id)`
- browser sort index on `(chain_id, collection_id, token_sort_bucket, token_sort_length, token_sort_value, token_id)`

### `collections`

Tracked by `database/migrations/007_collections_schema.sql`, `008_bootstrap_schema.sql`, and `015_opensea_offchain_schema.sql`.

Current important columns:

- onchain bootstrap state
    - `status` (`bootstrapping`, `live`, `paused`, `disabled`)
    - `bootstrap_anchor_block`
    - `bootstrap_started_at`, `bootstrap_finished_at`
    - `bootstrap_last_synced_block`
- OpenSea source identity/state
    - `opensea_slug`
    - `opensea_status`
    - `opensea_ready_at`
    - `opensea_snapshot_started_at`, `opensea_snapshot_completed_at`
    - `opensea_reconcile_started_at`, `opensea_reconcile_completed_at`
    - `opensea_last_stream_event_at`
    - `opensea_last_stream_healthy_at`
    - `opensea_last_error`

Important semantic split:

- `status = live` means onchain bootstrap finished
- `opensea_status = ready` means the first OpenSea snapshot finished successfully

### `collection_extension_installs`

Defined in `017_collection_extensions_schema.sql`.

Purpose:

- records which build-bundled collection extension is installed for a collection
- persists extension-owned config JSON in DB so runtime logic is DB-activated rather than hard-wired to the current process state

Key columns:

- `chain_id`
- `collection_id`
- `extension_key`
- `enabled`
- `config_json`
- `created_at`, `updated_at`

Current v1 constraint:

- primary key is `(chain_id, collection_id)`
- this means exactly one extension install row per collection in the current design

### `bootstrap_runs`

Defined in `014_bootstrap_runs.sql`.

Purpose:

- records the durable bootstrap request and lifecycle state per collection run
- persists request-time identity decisions that the bootstrap worker must honor later

Key columns:

- `chain_id`
- `collection_id`
- `request_slug`
- `request_opensea_slug`
- `request_address`
- `request_standard`
- `request_extension_key`
- `metadata_mode`
- `enumeration_mode`
- `manual_token_ids_json`
- `manual_range_start_token_id`
- `manual_range_total_supply`
- `request_image_cache_mode`
- `request_image_cache_max_dimension`
- `status`

Important contract:

- `request_extension_key` is resolved during bootstrap run creation from `chain_id + contract_address + token_scope`
- bootstrap-worker later installs that requested embedded extension by `collection_id`, without re-resolving by contract
- `request_image_cache_*` records the requested image cache mode and optional max resize dimension used by the later image-cache phase

### `bootstrap_image_cache_tasks`

Defined in `032_token_image_cache.sql`.

Purpose:

- tracks bootstrap-local caching tasks for canonical token metadata `image` media
- keeps cache failures retryable without blocking canonical metadata persistence
- produces settled `token_image_cache` rows when an image cache task succeeds

Key columns:

- identity
    - `run_id`
    - `chain_id`
    - `collection_id`
    - `contract_address`
    - `token_id`
- cache input
    - `source_image_url`
    - `requested_max_dimension`
- task state
    - `status` (`pending`, `retry`, `succeeded`, `failed_terminal`)
    - `attempts`
    - `next_attempt_at`
    - `last_error`
- cache output
    - `cache_key`
    - `content_type`
    - `source_bytes`
    - `cached_bytes`
    - `width`
    - `height`
    - `relative_path`
    - `public_path`

### `token_image_cache`

Defined in `032_token_image_cache.sql`.

Purpose:

- stores the local public path that backend read models can prefer over remote/IPFS image URLs
- represents settled cached token images produced by bootstrap image cache tasks or later token image cache queue jobs

Key columns:

- identity
    - `chain_id`
    - `collection_id`
    - `token_id`
- cache input
    - `source_image_url`
    - `requested_max_dimension`
- cache output
    - `cache_key`
    - `content_type`
    - `source_bytes`
    - `cached_bytes`
    - `width`
    - `height`
    - `relative_path`
    - `public_path`

Important semantics:

- primary key is `(chain_id, collection_id, token_id)`, so each token has one active cached canonical image variant
- seeding reads only successful bootstrap metadata snapshot tasks with a non-empty `token_metadata.image`
- backend serves `public_path` under `/media/token-images/...` from the configured local media cache directory
- read models prefer `public_path` only when `source_image_url` still matches the canonical `token_metadata.image`

### `nft_balance_snapshots`

Temporary ownership snapshot table used during collection bootstrap.

- Primary key: `(chain_id, collection_id, token_id)`
- Rows are finalized into `nft_balances` once the snapshot completes
- Snapshot finalization establishes the base current-state ownership at `bootstrap_anchor_block`

## Orders Table

Tracked by `database/migrations/003_orders_schema.sql`, `015_opensea_offchain_schema.sql`, and `016_offchain_source_scope.sql`.

The `orders` table is now the canonical normalized order model, not just a lightweight invalidation cache.

Important column groups:

- identity / scope
    - `id`
    - `chain_id`
    - `collection_id`
    - `kind`
    - `side`
    - `source`
    - `maker`, `taker`
    - `contract_address`, `token_id`
- source scope model
    - `source_scope_kind` (`token`, `collection`, `attribute`)
    - `source_criteria_root`
    - `source_schema_json`
    - `local_token_set_status` (`none`, `resolved`, `unresolved`, `mismatch`)
    - `token_set_id`, `token_set_schema_hash`
- pricing / validity
    - `price`
    - `currency`
    - `valid_from`, `valid_until`
- status split
    - `fillability_status`
    - `source_status`
- Seaport canonical data
    - `seaport_data_json`
    - `seaport_data_source_kind` (`stream` or `rest`)
- audit/debug payloads
    - `raw_rest_data`
    - `raw_stream_data`

### Status semantics

`fillability_status` is protocol/onchain truth:

- `fillable`
- `filled`
- `cancelled`
- `expired`
- `no-balance`
- `no-approval`
- `invalid`

`source_status` is source-visible activity from OpenSea:

- `active`
- `inactive`
- `cancelled`
- `filled`
- `invalidated`
- `expired`
- `unknown`

These do not auto-drive each other. A row can be source-active but onchain-unfillable, or source-inactive while still protocol-fillable.

## Historical Facts vs Current-State Projections

The storage/runtime contract is intentionally split:

- append-only historical facts can be persisted for any block range
    - `blocks`
    - `transactions`
    - `nft_transfer_events`
    - `fills`
    - `collection_extension_events`
- current-state/materialized tables are anchor-gated
    - `nft_balances`
    - metadata/materialized token state written downstream from sync
    - order invalidation side-effects triggered from onchain sync

In practice this means a manual backfill for `X-100 .. X-1` after a snapshot anchored at `X` enriches history, but it must not change current ownership.

### Raw payload invariant

`raw_rest_data` and `raw_stream_data` are audit/debug-only for indexer/order validation.

Runtime validation must use normalized canonical fields (`seaport_data_json`, side/maker/price/currency/scope fields), not raw stored JSON. The runtime SQL paths intentionally do not select the raw payload columns for order validation.

Exception:

- trading bid-book fallback may parse raw OpenSea payloads with the shared bidding-offer parser for read-only bid display
- this exception does not make raw payloads authoritative for bidder decisions, order validation, or indexer domain projections

## Offchain OpenSea Tables

### `offchain_order_observations`

Defined in `015_opensea_offchain_schema.sql`.

Purpose:

- append-only audit trail for all raw OpenSea observations
- stores both stream and REST-originated observations
- allows later debugging of source-vs-canonical normalization issues

Key columns:

- `chain_id`, `collection_id`
- `source`
- `channel` (`stream`, `snapshot`, `reconcile`)
- `dedupe_key`
- `event_type`
- `order_id`
- `run_id`
- `received_at`
- `source_event_at`
- `payload_json`

Timestamp semantics:

- `received_at` = local observation time when ArtGod saw the payload
- `source_event_at` = source-derived timestamp if available, otherwise `NULL`

Operational note:

- raw observation persistence is disabled by default with `OFFCHAIN_PERSIST_RAW_OBSERVATIONS=false`
- when disabled, downstream normalization and canonical order updates still run; only the audit trail table stops growing
- set `OFFCHAIN_PERSIST_RAW_OBSERVATIONS=true` when raw audit payload history is needed

### `opensea_orderbook_runs`

Defined in `015_opensea_offchain_schema.sql`.

Purpose:

- tracks snapshot and reconcile runs per collection
- records whether a run completed or failed

Key columns:

- `run_id`
- `chain_id`, `collection_id`
- `kind` (`snapshot`, `reconcile`)
- `status` (`running`, `completed`, `failed`)
- `started_at`, `completed_at`
- `error_message`

## Seaport Conduit Cache

Defined in `database/migrations/009_seaport_conduits.sql`.

Tables:

- `seaport_conduits`
- `seaport_conduit_channels`

Purpose:

- caches `conduitKey -> conduitAddress`
- caches conduit channel memberships
- avoids repeated ConduitController RPC reads during Seaport validation

## Token Set Tables

Defined in `database/migrations/010_token_sets_schema.sql`.

Token-set materialization is still local SQLite state. Offchain order ingestion may attach local linkage (`token_set_id`, `token_set_schema_hash`) when it can resolve the source scope against local metadata, but canonical order persistence no longer depends on successful token-set resolution.

## Collection Extension Artifact Tables

### `token_extension_artifacts`

Defined in `017_collection_extensions_schema.sql`.

Purpose:

- stores extension-owned, latest-state token artifacts separately from canonical `token_metadata`
- keeps collection-specific caches isolated from the default metadata model
- supports backend read-time presentation overrides without mutating canonical token metadata rows

Key columns:

- identity
    - `chain_id`
    - `collection_id`
    - `contract_address`
    - `token_id`
    - `extension_key`
    - `artifact_ref`
- artifact payload
    - `uri`
    - `raw_json`
    - `attributes_json`
    - `image`
    - `animation_url`
    - `html_content`
- audit timestamps
    - `created_at`
    - `updated_at`

Important semantics:

- primary key is `(chain_id, collection_id, token_id, extension_key, artifact_ref)`
- writes are upserts, so the table holds current artifact state rather than history
- foreign key references `tokens(chain_id, collection_id, token_id)`
    - canonical token rows must exist first
    - this is why collection-extension refresh runs only after canonical metadata persistence succeeds

Current Terraforms artifact usage:

- `extension_key = "terraforms"`
- `artifact_ref = "terraforms-v2-media"`
- `artifact_ref = "terraforms-v2-lost-terrain"` for non-Terrain tokens only
- `uri` stores the raw v2 renderer `tokenURI(...)` response
- `raw_json` stores the decoded JSON payload returned by the metadata fetcher
- `attributes_json`, `image`, and `animation_url` store the parsed v2 metadata fields
- `html_content` stores the direct v2 renderer `tokenHTML(...)` response used for backend animation override
- backend resolves Terraforms collection browsing from `terraforms-v2-media`
- backend exposes `terraforms-v2-lost-terrain` only as a token-local media mode on token detail / preview

## Local Token Image Cache

The token image cache is separate from canonical metadata and extension artifact storage.

- It caches `token_metadata.image`, not `animation_url`.
- The indexer writes resized files through `indexer/src/infra/media/sharp-token-image-cache.ts`.
- Resized cache output is WebP; original-size cache output preserves the source bytes and inferred content type.
- File roots come from `COMMON_MEDIA_CACHE_DIR` or the default path beside `ARTGOD_DB_PATH`.
- Backend static serving is path-scoped to `/media/token-images/*`.
- Generic collection read models prefer cached image paths before remote canonical image URLs.

## Storage Adapter Behavior

### Onchain storage (`indexer/src/infra/storage/sqlite.ts`)

Key operations:

- `persistSyncResult()`
    - writes blocks
    - upserts per-collection block coverage for targeted collections
    - inserts transfer events, fills, and collection-extension events idempotently
    - applies balance updates only for newly inserted transfers
- `getBlockHash()`
    - reads block hash for reorg verification
- `rollbackFromBlock()`
    - reverses balances from orphaned transfers
    - deletes transfers, fills, collection-extension events, activities, transactions, and blocks from the rollback point onward

### Collection registry (`indexer/src/infra/collections/sqlite.ts`)

Tracks both bootstrap lifecycle and OpenSea lifecycle.

Important operations:

- upsert collection registration
- mark bootstrap phases complete
- mark OpenSea identity/snapshot/reconcile phases
- list collections eligible for OpenSea subscription or reconciliation

### Offchain observation store (`indexer/src/infra/offchain/sqlite-observations.ts`)

- `INSERT OR IGNORE` by `(chain_id, source, dedupe_key)`
- stores raw source payloads without mutating canonical order state directly

### Order source-state store (`indexer/src/infra/offchain/sqlite-order-source-state.ts`)

- marks missing previously-active orders `source_status = inactive`
- does **not** mark them `cancelled`
- scope is `(chain_id, collection_id, source)` plus `id NOT IN (...)`

### Orders domain storage (`indexer/src/infra/domain/orders.ts`)

- persists canonical normalized order rows via `orders.upsert`
- writes `source_status` and `fillability_status` independently
- stores canonical `seaport_data_json`
- stores raw stream/rest payloads for audit only
- async validation later reads canonical order state back from `orders`
