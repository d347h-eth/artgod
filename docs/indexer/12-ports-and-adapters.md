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

## Head Source Port

- Interface: `indexer/src/ports/head-source.ts`
- Adapter: `indexer/src/infra/rpc/viem-ws.ts`

Provides a WebSocket head listener used by the scheduler.

## Storage Port

- Interface: `indexer/src/ports/storage.ts`
- Adapter: `indexer/src/infra/storage/sqlite.ts`

Persists sync results, exposes block hash lookup, and supports rollback.

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
