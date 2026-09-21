# Activities Domain

The activities domain is a feed-oriented historical projection.

It is not the system of record for ownership, fills, or offchain orders. Those
raw facts remain in their source tables and streams. The activities projection
exists to provide a product-facing historical feed shape for collection/token
activity.

Primary files:

- `indexer/src/domain/activities.ts`
- `indexer/src/domain/activity-jobs.ts`
- `indexer/src/infra/domain/activities.ts`
- `shared/market-data/storage-policy.ts`
- `shared/database/current-asks.ts`
- `indexer/src/infra/storage/sqlite-daily-listing-prices.ts`

Schema:

- `database/migrations/005_activities_schema.sql`
- `database/migrations/055_market_data_storage_lifecycle.sql`

## Projection Role

Raw source facts remain authoritative:

- `nft_transfer_events` for transfers
- `fills` for sales
- offchain stream payloads plus canonical order state for listings/bids

`activities` is the historical feed projection built from those sources.

## Inputs

The activities domain consumes two inputs:

1. `domain.activity.sync`
    - block-range sync input from the onchain pipeline
    - projects onchain activity from persisted raw facts
    - currently always published with `projection = facts_only`

2. `activities.upsert`
    - immutable normalized activity input from non-block-range producers
    - currently used by offchain dispatch for OpenSea stream-derived activity

## Activity Shape

Activities are normalized into a feed-ready record with:

- scope (`token`, `collection`, `attribute`)
- product-facing kind
- occurred-at timestamp
- provenance (`sourceKind`, `sourceName`)
- optional order / tx / block references
- participants (`from`, `to`, `maker`, `taker`)
- economics (`amount`, `price`, `currency`)
- JSON payload for future extension-specific detail

The schema already supports broader scope kinds, but current emission is focused
on token-scoped core activity.

## Current Kinds

Retained core activity kinds are:

- `transfer`
- `sale`
- `listing_created`

The older bid-create/cancel and listing-cancel wire kinds remain recognizable
for compatibility, but offchain dispatch no longer publishes their activity
jobs and the projector rejects already-queued deliveries. The generic activity
API excludes that removed offchain history too. Independent order-state
updates still consume cancellation, invalidation and bid inputs.

Custom extension activity is emitted from persisted `collection_extension_events` rows. The generic activity row keeps `kind = "custom"`, `source_kind = "extension"`, `source_name = <extension key>`, and extension-owned payload JSON.

## Onchain Projection

`domain.activity.sync` reads persisted raw rows in the requested block range and
projects:

- `transfer` from `nft_transfer_events`
- `sale` from `fills`
- `custom` extension activity from `collection_extension_events`

Important behavior:

- sales and transfers remain separate feed items
- sales keep price / currency / timestamp from fills
- projection uses idempotent insert semantics via dedupe keys
- historical backfill before the bootstrap anchor is still valid here because activities are a feed projection over append-only facts, not a current-state table

## Offchain Projection

Offchain producers publish normalized `activities.upsert` jobs.

Current producer:

- `indexer/src/application/offchain/dispatch.ts`

Current policy:

- historical offchain activity is emitted from stream events only
- snapshot / reconcile inputs update canonical order state but do not create
  historical activity rows

OpenSea listing creation records a daily `listing_created` row, not a copy of
each order event. REST snapshots maintain orders but never invent daily events.

## Permanent Daily Listings

- **Identity:** chain, collection, token, seller and UTC day. Currency and order
  ID do not create separate daily rows.
- **Position:** the earliest source event time in that day. A late earlier event
  can correct the time downward; later events never promote the row.
- **Retention:** permanent, including after cancellation, sale and expiry. No
  age or count cap. An idle day does not create a row.
- **Stored content:** identity, pinned time, source attribution and the last
  recorded price/currency/order reference for that day. No order payload archive
  or individual event count.
- **Price updates:** today's row uses the lowest valid ask for that token and
  seller when orders change or maintenance runs. If none remains, keep the last
  recorded price. Never replace older days with today's price.
- **Delayed events:** an event from an earlier day carries its own historical
  price; it must not use today's orderbook.

Source occurrence time is preferred; missing source time uses the original
envelope's receive time. Missing token/seller, invalid time, inputs over five
minutes in the future and deleted collections are rejected. Older valid events
remain admissible; they belong in permanent history.

## Source Attribution vs Idempotency

There are two separate concepts:

1. Activity row provenance
    - `sourceKind` / `sourceName`
    - answers "where did this feed row come from?"

2. Upstream event identity
    - `sourceKind` / `sourceName` / `sourceEventKey` in `activities.upsert`
    - identifies the incoming event; it is not a separate receipt ledger

Daily identity is independent of transport aliases. Duplicate observations and
unchanged prices do not rewrite the row or advance AUTOINCREMENT. A changed
same-day price updates the existing row without moving its feed position.
Onchain/extension events retain their fact-derived dedupe keys.

The legacy `activity_sources` table was bookkeeping for the removed mutable
projector, not user-facing market information. No new receipts are written;
startup recovery removes the table after rebuilding retained activities.

## Read-Model Note

Collection, token and maker-filtered feeds read the same stored daily rows.
There is no request-time grouping of listing history. Cursor order and exact
totals count daily rows, not raw listing events.

Daily price updates and card-grid reads share the current-ask eligibility query:
active source, fillable token ask, supported native ETH/WETH currency, valid
start time and strictly future expiry. Decimal integer prices are compared
exactly, without floating point. Daily updates select within a seller; cards select
across sellers. Card reads check validity even before order maintenance runs.
Price-ordered token and seller indexes avoid sorting the full orderbook.
The feed API reads its stored historical prices without an orderbook join.

Migration 055 initializes startup recovery, which resets legacy listing history
once. Daily rows created under the new model survive later recovery.
The domain worker continuously retires obsolete orders, never daily rows.

Extension content-hash/event-group queries explicitly constrain `kind=custom`
to match the narrowed expression indexes. Three obsolete open-row/order/contract
activity indexes are removed; feed and unique deduplication indexes remain.

## Current Limits and Future Direction

- Holder totals are queried from current balances; there is no separately
  scheduled collection owner-count projection.
- Activity projection is intentionally facts-first. Search-specific external
  indexing or analytics fan-out is not part of the local public-alpha runtime.
- Daily history can grow with distinct active token/seller/days; current valid
  orders are not capped. Neither store has a fixed byte ceiling. See the
  [product contract](../development/03-sqlite-storage-and-recovery.md#2-listings-permanent-history-current-orderbook).
