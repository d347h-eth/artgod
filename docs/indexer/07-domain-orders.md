# Orders Domain

The orders domain is a minimal first pass that reacts to transfers by invalidating orders whose makers no longer hold the token.

Primary file:

- `indexer/src/infra/domain/orders.ts`

Schema:

- `database/migrations/003_orders_schema.sql`

## Inputs

The orders domain consumes `domain.orders.sync` jobs. Each job provides:

- `chainId`
- `fromBlock`, `toBlock`
- `mode` (`realtime` or `backfill`)
- `sourceJobId`, `sourceKind`

The domain reads transfer events from `nft_transfer_events` within the block range.

## Trigger Meanings

The indexer uses four trigger categories to keep the orderbook correct:

- **Fill**: on-chain execution of an order (Seaport/Blur/on-chain orderbooks).
- **Cancel**: explicit on-chain invalidation (e.g. Seaport cancel/counter).
- **Order**: on-chain creation/listing for orderbooks that emit order data on-chain.
- **Maker trigger**: maker’s fillability changed (balance/approval/ownership), requires re-validation.

Maker triggers are _not_ cancels. Spending WETH or revoking approval should enqueue maker updates, not cancels, because the order can become fillable again if funds/approvals return.

## Order Update Queues

Two queues are reserved for order maintenance:

- `order-updates-by-maker`: re-validate all orders affected by maker state changes.
- `order-updates-by-id`: update a specific order after fill/cancel/on-chain order creation.

Handlers now update order status by id for `fill`, `cancel`, and `order` triggers (best-effort, no insertion yet). Maker-based updates remain minimal and only log.

## Logic

The current implementation:

1. Reads all transfers in the range where `from_address != ZERO_ADDRESS`.
2. Builds unique keys `(maker, contract, tokenId)` for each outgoing transfer.
3. For each unique key, updates orders where:
    - `chain_id`, `maker`, `contract`, `token_id` match.
    - `fillability_status != 'no-balance'`.
4. Sets `fillability_status` to `no-balance` and updates `updated_at`.

This keeps order invalidation simple and idempotent.

On reorg rollback, orders that were invalidated by transfers in orphaned blocks are reset back to `fillable` (best-effort), and on-chain orders in the rolled-back range are deleted.

## Current Scope and Limits

- Order invalidation and status updates are implemented; order creation is still a stub (no insert yet).
- The schema supports richer fields (price, currency, validity), but they are not populated at this stage.
- This domain is intentionally minimal to keep the pipeline lean for MVP.
