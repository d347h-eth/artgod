# Storage and Schema

This document describes the SQLite schema and storage adapter used by the indexer.

Primary files:

- `shared/database/db.ts`
- `shared/database/migrations.ts`
- `indexer/src/infra/storage/sqlite.ts`
- `database/migrations/*.sql`

## SQLite Configuration

The shared database wrapper (`shared/database/db.ts`) enforces:

- `ARTGOD_DB_PATH` must be set in the environment.
- WAL journal mode for better read/write concurrency.
- `synchronous = NORMAL`.
- `foreign_keys = ON`.
- `busy_timeout = 5000`.

All code uses a single connection per process, created on demand.

## Migration Runner

Migrations are applied at runtime startup via `createMigrationRunner()`:

- Ensures a `migrations` table.
- Executes SQL files in `database/migrations/` sorted by filename.
- Uses `BEGIN IMMEDIATE` to serialize migrations.

The migration runner is invoked by sync, reorg, and domain workers.

## Core Tables (Indexer)

Defined in `database/migrations/002_indexer_schema.sql`:

### blocks

```
blocks(chain_id, block_number, block_hash, parent_hash, timestamp)
```

- Primary key: `(chain_id, block_number)`.
- Used for reorg detection and persistence of head metadata.

### transactions

```
transactions(chain_id, tx_hash, from_address, to_address, input,
             block_number, block_hash, block_timestamp)
```

- Primary key: `(chain_id, tx_hash)`.
- Stores calldata only for transactions that emitted relevant events.
- Indexed by `(chain_id, block_number)` for rollback cleanup.

### sync_state

```
sync_state(key, value)
```

- Generic KV store for future sync cursors or checkpoints.
- Present but not used yet.

### nft_transfer_events

```
nft_transfer_events(chain_id, contract, from_address, to_address, token_id, amount,
                    block_number, block_hash, block_timestamp, tx_hash, log_index, kind)
```

- Unique constraint on `(chain_id, tx_hash, log_index, contract, token_id)`.
- Indexed by `(chain_id, contract, token_id)` and `(chain_id, tx_hash)`.
- `amount` stored as TEXT to preserve large integer precision.
- `block_timestamp` records the canonical block time for analytics.

### nft_balances

```
nft_balances(chain_id, contract, token_id, owner, amount,
             last_block_number, last_block_hash, last_block_timestamp,
             last_tx_hash, last_log_index)
```

- Primary key: `(chain_id, contract, token_id, owner)`.
- `amount` stored as TEXT to preserve large integer precision.
- Attribution columns capture the last on-chain event that changed the balance.

## Domain Tables

### Orders

`database/migrations/003_orders_schema.sql`:

- `orders` table stores a minimal order model.
- Current usage is limited to invalidating orders when balances change.
- Additional attribution columns are reserved for future order ingestion:
    - `block_hash`, `block_timestamp`, `tx_from`, `tx_to`, `tx_input`.
    - These fields are nullable and only expected to be populated for on-chain orderbooks.
- `side` (buy/sell) is used by the bidder index to scope WETH-triggered maker updates.

### Metadata

`database/migrations/004_metadata_schema.sql`:

- `token_metadata` table stores resolved metadata and attributes.
- `attributes_json` and `raw_json` are stored as JSON strings.
- Attribution columns (`block_number`, `block_hash`, `block_timestamp`, `tx_hash`, `log_index`) capture the on-chain event that triggered the fetch.

### Activities

`database/migrations/005_activities_schema.sql`:

- `activities` table stores transfer and fill activities.
- Unique constraint prevents duplicate activity rows.

### Fills

`database/migrations/006_fills_schema.sql`:

- `fills` table stores decoded on-chain fills with price/currency attribution.
- Unique constraint on `(chain_id, tx_hash, log_index, contract, token_id, kind)` keeps inserts idempotent.

## Collection Bootstrap Tables

### collections

`database/migrations/007_collections_schema.sql` (+ `008_bootstrap_schema.sql`):

- Tracks collection registration and bootstrap state.
- Key columns:
    - `status` (`bootstrapping`, `live`, `paused`, `disabled`)
    - `bootstrap_anchor_block`
    - `bootstrap_started_at`, `bootstrap_finished_at`
    - `bootstrap_last_synced_block`

### nft_balance_snapshots

`database/migrations/008_bootstrap_schema.sql`:

- Temporary ownership snapshot table used during collection bootstrap.
- Primary key: `(chain_id, collection_id, token_id)`.
- Rows are finalized into `nft_balances` once the snapshot completes.

## Seaport Conduit Cache

`database/migrations/009_seaport_conduits.sql`:

- `seaport_conduits` caches `conduitKey -> conduitAddress` lookups.
- `seaport_conduit_channels` caches conduit open channels.
- Used during offchain Seaport order validation to resolve approval targets.

## Storage Adapter Behavior

`indexer/src/infra/storage/sqlite.ts` implements `StoragePort`.

Key operations:

- `persistSyncResult()`
    - Writes blocks.
    - Inserts transfer events (ignore duplicates).
    - Inserts fills (ignore duplicates).
    - Applies balance updates only for newly inserted transfers.

- `getBlockHash()`
    - Reads block hash for reorg verification.

- `rollbackFromBlock()`
    - Loads transfers at and above a block.
    - Applies reverse transfers to balances.
    - Deletes transfers, fills, activities, and blocks from that block onward.

ERC721 balance updates are done via delete/insert to enforce single-owner semantics. ERC1155 uses balance deltas in place.
