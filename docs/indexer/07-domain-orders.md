# Orders Domain

The orders domain persists canonical order rows and maintains their fillability through dedicated update queues.

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

`domain.orders.sync` is currently a no-op placeholder. Order state changes flow through dedicated order update jobs instead of hidden range-wide invalidation logic.

The orders domain also consumes `orders.upsert` jobs for offchain order ingestion. These jobs carry a normalized order payload (maker/side/price/token) and are persisted directly into the `orders` table.

After an upsert with `validateAfterUpsert`, the domain worker emits an `orders.update-by-id` job to validate the offchain order on-chain (Seaport).

## Trigger Meanings

The indexer uses four trigger categories to keep the orderbook correct:

- **Fill**: on-chain execution of an order (Seaport/Blur/on-chain orderbooks).
- **Cancel**: explicit on-chain invalidation (e.g. Seaport cancel/counter).
- **Order**: on-chain creation/listing for orderbooks that emit order data on-chain.
- **Maker trigger**: maker’s fillability changed (balance/approval/ownership), requires re-validation.

Maker triggers are _not_ cancels. Spending WETH or revoking approval should enqueue maker updates, not cancels, because the order can become fillable again if funds/approvals return.

## Bidder Index (Quiet Default)

WETH transfer/approval logs can trigger maker updates, but to avoid queue spam we gate these triggers behind a bidder index:

- The index is refreshed from the `orders` table (`side = buy`).
- If the index is **not ready** (never loaded) or **empty**, WETH-triggered maker updates are **not emitted** (quiet default).
- When non-empty, only makers in the index receive WETH-triggered updates.

## Order Update Queues

Order queues used by the domain:

- `orders-upsert`: insert/update normalized offchain orders.
- `order-updates-by-maker`: re-validate all orders affected by maker state changes.
- `order-updates-by-id`: update a specific order after fill/cancel/on-chain order creation.

Handlers now update order status by id for `fill`, `cancel`, and `order` triggers. For `order` triggers tied to offchain ingestion, the domain validates Seaport orders by:

- Verifying order hash + signature.
- Checking time window and on-chain order status.
- Resolving conduit approvals (via ConduitController + local cache).
- Checking maker balance/approvals.

Validation can set `fillability_status` to `fillable`, `expired`, `cancelled`, `filled`, `no-balance`, `no-approval`, or `invalid`.

Maker-based updates are selective re-validation triggers:

- `nft-transfer`, `item_sold`, `item_transferred`
  - re-validate exact-token sell orders for the maker
- `erc20-balance`, `approval-change`
  - re-validate WETH-denominated buy orders for the maker
- `order-counter`
  - re-validate all Seaport orders for the maker

## Logic

The current implementation:

1. Persists offchain order upserts into the canonical `orders` table.
2. Uses `orders.update-by-id` for explicit fills, cancels, and on-chain order re-checks.
3. Uses `orders.update-by-maker` for reason-scoped Seaport re-validation.
4. Updates only `fillability_status` from validation results; source-market activity remains tracked separately via `source_status`.

On reorg rollback, orders that were invalidated by transfers in orphaned blocks are reset back to `fillable` (best-effort), and on-chain orders in the rolled-back range are deleted.

## Current Scope and Limits

- Order update queues, status updates, and offchain order upserts are implemented.
- The schema supports richer fields (price, currency, validity), but only the normalized subset is populated.
- This domain is intentionally minimal to keep the pipeline lean for MVP.
