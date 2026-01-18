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

## Logic

The current implementation:

1. Reads all transfers in the range where `from_address != ZERO_ADDRESS`.
2. Builds unique keys `(maker, contract, tokenId)` for each outgoing transfer.
3. For each unique key, updates orders where:
   - `chain_id`, `maker`, `contract`, `token_id` match.
   - `fillability_status != 'no-balance'`.
4. Sets `fillability_status` to `no-balance` and updates `updated_at`.

This keeps order invalidation simple and idempotent.

## Current Scope and Limits

- Only invalidation is implemented; no order creation or fill capture yet.
- The schema supports richer fields (price, currency, validity), but they are not populated at this stage.
- This domain is intentionally minimal to keep the pipeline lean for MVP.
