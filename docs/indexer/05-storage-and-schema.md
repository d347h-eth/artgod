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
nft_transfer_events(chain_id, contract, from_address, to_address, token_id, amount,
                    block_number, block_hash, block_timestamp, tx_hash, log_index, kind)
```

- Unique constraint on `(chain_id, tx_hash, log_index, contract, token_id)`
- Indexed by `(chain_id, contract, token_id)` and `(chain_id, tx_hash)`
- `amount` stored as `TEXT` to preserve integer precision

### `nft_balances`

```sql
nft_balances(chain_id, contract, token_id, owner, amount,
             last_block_number, last_block_hash, last_block_timestamp,
             last_tx_hash, last_log_index)
```

- Primary key: `(chain_id, contract, token_id, owner)`
- Canonical current ownership table after bootstrap completion
- Attribution columns capture the last onchain event that changed the balance

## Collection and Bootstrap Tables

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

### `nft_balance_snapshots`

Temporary ownership snapshot table used during collection bootstrap.

- Primary key: `(chain_id, collection_id, token_id)`
- Rows are finalized into `nft_balances` once the snapshot completes

## Orders Table

Tracked by `database/migrations/003_orders_schema.sql`, `015_opensea_offchain_schema.sql`, and `016_offchain_source_scope.sql`.

The `orders` table is now the canonical normalized order model, not just a lightweight invalidation cache.

Important column groups:

- identity / scope
  - `id`
  - `chain_id`
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

### Raw payload invariant

`raw_rest_data` and `raw_stream_data` are audit/debug-only.

Runtime validation and downstream logic must use normalized canonical fields (`seaport_data_json`, side/maker/price/currency/scope fields), not raw stored JSON. The runtime SQL paths intentionally do not select the raw payload columns for order validation.

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

## Storage Adapter Behavior

### Onchain storage (`indexer/src/infra/storage/sqlite.ts`)

Key operations:

- `persistSyncResult()`
  - writes blocks
  - inserts transfer events and fills idempotently
  - applies balance updates only for newly inserted transfers
- `getBlockHash()`
  - reads block hash for reorg verification
- `rollbackFromBlock()`
  - reverses balances from orphaned transfers
  - deletes transfers, fills, activities, transactions, and blocks from the rollback point onward

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
- scope is `(chain_id, source, contract_address)` plus `id NOT IN (...)`

### Orders domain storage (`indexer/src/infra/domain/orders.ts`)

- persists canonical normalized order rows via `orders.upsert`
- writes `source_status` and `fillability_status` independently
- stores canonical `seaport_data_json`
- stores raw stream/rest payloads for audit only
- async validation later reads canonical order state back from `orders`
