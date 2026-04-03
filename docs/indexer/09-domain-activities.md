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

Schema:

- `database/migrations/005_activities_schema.sql`

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

Current core activity kinds are:

- `transfer`
- `sale`
- `listing_created`
- `listing_cancelled`
- `bid_created`
- `bid_cancelled`

Custom extension activity is reserved in the domain model but not emitted yet.

## Onchain Projection

`domain.activity.sync` reads persisted raw rows in the requested block range and
projects:

- `transfer` from `nft_transfer_events`
- `sale` from `fills`

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

Typical mappings:

- OpenSea list event -> `listing_created`
- OpenSea cancel/invalidation -> `listing_cancelled`
- OpenSea bid/offer event -> `bid_created`
- bid invalidation -> `bid_cancelled`

## Coalescing and Open Rows

Listings and bids can be noisy in offchain orderbooks. The projection handles
this with open-row coalescing.

Projection lifecycle state:

- `open`
    - the current active coalescible create-row
    - still eligible for in-place repricing updates
- `closed`
    - historical/final row
    - no longer mutated by the projector

Current coalescing rules:

- applies to `listing_created` and `bid_created`
- same token + maker + side + currency + kind can update the current open row
- small reprices are coalesced in place
- explicit cancel rows remain their own historical entries
- a later sale or cancel closes the matching open create row

This keeps raw upstream history truthful while making the feed projection less
spammy.

## Source Attribution vs Idempotency

There are two separate concepts:

1. Activity row provenance
    - `sourceKind` / `sourceName`
    - answers "where did this feed row come from?"

2. Upstream event identity
    - `sourceKind` / `sourceName` / `sourceEventKey` in `activities.upsert`
    - answers "did we already consume this exact upstream event?"

The `activity_sources` table exists for projector bookkeeping and idempotency.
It is not a second user-facing source model.

## Read-Model Note

Backend/feed read models may apply additional presentation-layer grouping such as
collapsed collection listings. That collapsing happens after projection and does
not change the truthful activity rows stored in `activities`.
