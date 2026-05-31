# Ports and Adapters

The indexer uses explicit ports and adapters to keep cross-process boundaries stable and to make future infra swaps straightforward.

Ports live in `indexer/src/ports/` and are used by application/runtime logic. Adapters live in `indexer/src/infra/`.

## Queue Port

- Interface: `indexer/src/ports/queue.ts`
- Adapter: `indexer/src/infra/queue/nats.ts`

Provides publish/subscribe semantics with explicit ack/nack/touch.

## RPC Port

- Interface: `indexer/src/ports/rpc.ts`
- Adapter: `indexer/src/infra/rpc/viem.ts`

Supports `getBlockNumber`, `getBlock`, `getLogs`, `getTransaction`, and `getTransactionReceipt` with log chunking and retry behavior.

`readContract` is used for bootstrap ownership snapshots and offchain order validation. `getBalance` is used for native-ETH order checks.

The viem adapter accepts a weighted HTTP JSON-RPC endpoint pool from `RPC_URL`. Selection uses the configured weights as the baseline and lowers an endpoint's effective weight after request failures so later attempts drift toward healthier endpoints. Adjusted weights are in-memory only.

## Head Source Port

- Interface: `indexer/src/ports/head-source.ts`
- Adapter: `indexer/src/infra/rpc/viem-ws.ts`

Provides a WebSocket head listener used by the scheduler-worker.

The viem WebSocket adapter accepts a separate weighted endpoint pool from `RPC_WS_URL`. It keeps one active connection to the highest effective-weight endpoint, records socket/listener failures against that endpoint, and reconnects through the same in-memory weight adjustment policy used by the HTTP pool. HTTP polling remains authoritative and fills any missed heads.

## Storage Port

- Interface: `indexer/src/ports/storage.ts`
- Adapter: `indexer/src/infra/storage/sqlite.ts`

Persists sync results, exposes block hash lookup, and supports rollback.

The storage adapter is also the last-line ownership guard:

- raw blocks/transfers/fills are always persisted for the requested range
- `nft_balances` updates are applied only for transfer events that are strictly post-anchor for the affected collection

## Collection Registry Port

- Interface: `indexer/src/ports/collections.ts`
- Adapter: `indexer/src/infra/collections/sqlite.ts`

Provides collection registry reads for sync workers and bootstrap state updates.

## Bootstrap Snapshot Port

- Interface: `indexer/src/ports/bootstrap.ts`
- Adapter: `indexer/src/infra/bootstrap/sqlite.ts`

Stores ownership snapshots and finalizes snapshot state into `nft_balances`.

## Cache Port

- Interface: `indexer/src/ports/cache.ts`
- Adapter: `indexer/src/infra/cache/memory.ts`

Provides basic in-memory caching for RPC calls with metric hooks.

## Domain Handler Ports

- Interface: `indexer/src/ports/domain-handlers.ts`
- Adapters:
    - Orders: `indexer/src/infra/domain/orders.ts`
    - Metadata: `indexer/src/infra/domain/metadata.ts`
    - Activities: `indexer/src/infra/domain/activities.ts`

These ports allow the sync pipeline to remain independent of domain-specific persistence logic.

The shared `DomainSyncContext` also carries explicit projection intent:

- `facts_only` for historical-safe feed projection
- `current_state` for anchor-eligible materialized writes

Orders domain also exposes update-by-maker and update-by-id handlers for fillability and explicit order events.

## Bidder Index Port

- Interface: `indexer/src/ports/bidder-index.ts`
- Adapter: `indexer/src/infra/bidder-index/sqlite.ts`

Provides a refreshable set of bid makers (currently sourced from the `orders` table) used to gate WETH-triggered maker updates.

## Conduit Registry Port

- Interface: `indexer/src/ports/conduits.ts`
- Adapter: `indexer/src/infra/conduits/sqlite.ts`

Caches Seaport conduit lookups (`conduitKey -> conduitAddress`) for offchain order validation.
Also caches conduit channel lists used to ensure the Seaport exchange is an open channel.

## Metadata Ports

- Interface: `indexer/src/ports/metadata.ts`
- Adapters:
    - `indexer/src/infra/metadata/viem-token-uri.ts`
    - `indexer/src/infra/metadata/http-fetcher.ts`

These ports keep metadata resolution and HTTP fetching swappable.

## Collection Extension Ports

- Interface: `indexer/src/ports/collection-extensions.ts`
- Adapter: `indexer/src/infra/collection-extensions/sqlite.ts`

Provides two related storage-facing responsibilities:

- install registry access
    - get install by collection
    - list enabled installs
    - upsert install rows
- artifact and normalized-token reads
    - upsert extension artifact rows
    - read extension artifact rows
    - resolve normalized token attribute values for extension logic

This adapter intentionally reads normalized attribute state from SQLite so collection-specific logic can depend on canonical metadata outputs without re-parsing raw metadata JSON.

## Embedded Extension Registry

Shared embedded extension definitions live in `shared/extensions/index.ts`.

The original design discussion considered a single dedicated top-level extension module directory. The implemented version keeps the shared install/config registry in `shared/` and separates indexer/backend extension logic by layer instead, so each runtime stays within its own port/adapter boundary.

Current responsibilities:

- define known extension keys
- resolve embedded installs by `chainId + contractAddress + tokenScope` during bootstrap run creation
- resolve persisted embedded install definitions by `chainId + extensionKey` during bootstrap worker install
- validate extension-owned config JSON
- define stable artifact refs used across indexer and backend

Indexer-side extension implementations live in:

- `indexer/src/application/collection-extensions/index.ts`
- `indexer/src/application/collection-extensions/types.ts`
- `indexer/src/application/collection-extensions/terraforms.ts`

The indexer extension contract currently exposes two behaviors:

- `buildSyncWatchSpecs(...)`
    - returns extra log watch definitions for sync-worker
- `refreshArtifacts(...)`
    - executes extension-owned artifact refresh logic on the dedicated collection-extension queue

Backend keeps a separate presentation-oriented extension registry under `backend/src/application/collection-extensions/*` so backend read-model code depends only on backend-local contracts, not on indexer adapters.
