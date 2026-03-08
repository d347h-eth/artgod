# Collection Bootstrap

This document describes the implemented per-collection bootstrap flow.

The goal is to reach a correct local ownership state quickly and then attach OpenSea orderbook tracking without blocking core onchain correctness.

## Why Bootstrap Exists

`nft_balances` is the canonical current ownership table, but it is only correct when:

1. we have a snapshot anchored to a specific block, and
2. we have processed every transfer after that block with no gaps

Full backfill from genesis also works, but it is too expensive for the normal local-first path.

## Current Lifecycle

Each collection starts outside the indexed set. When the user adds a collection, the bootstrap worker runs a deterministic pipeline.

### 1. Register collection

- persist collection config in `collections`
- set `status = bootstrapping`
- create a bootstrap run
- enqueue `bootstrap.collection.start`

### 2. Pick anchor block

- choose `head - reorgDepth`
- persist `bootstrap_anchor_block`
- this block becomes the ownership truth point for snapshotting

### 3. Metadata snapshot

- enumerate collection token ids
- fetch/store metadata first
- this step runs before OpenSea offchain work so local token/attribute context exists

### 4. Ownership snapshot

- capture ownership at the anchor block
- persist snapshot rows and finalize `nft_balances` base state

### 5. Schedule short backfill

- enqueue short backfill from `anchor + 1` to current head
- bootstrap later checks block coverage before finishing the onchain bootstrap run
- the short backfill is collection-scoped

### 6. Schedule OpenSea bootstrap

After local metadata + ownership are available, bootstrap enqueues an OpenSea bootstrap job.

That OpenSea flow does:

1. resolve OpenSea slug from collection contract
2. persist the slug in `collections.opensea_slug`
3. start the initial OpenSea orderbook snapshot
4. let the stream worker subscribe using the persisted slug

This OpenSea work runs in parallel with the short onchain backfill.

### 7. Mark collection `live`

When the short backfill is complete, the bootstrap worker marks the collection `status = live`.

This means:

- local ownership state is ready
- realtime onchain sync should include the collection

It does **not** mean OpenSea is necessarily ready yet.

### 8. Mark OpenSea offchain `ready`

The OpenSea bootstrap worker marks the collection OpenSea state `ready` after the first full snapshot succeeds.

This is tracked separately via:

- `opensea_status`
- `opensea_ready_at`
- snapshot/reconcile timestamps
- stream health timestamps

## OpenSea Reconcile Behavior

After the initial snapshot:

- live stream updates continue through the stream worker
- periodic reconcile keeps the local source-active set from drifting if stream events were missed
- reconcile scheduler also triggers an immediate run on startup for collections whose OpenSea state is stale

Current defaults:

- periodic reconcile: every 15 minutes
- stale-start threshold: 30 minutes

These are config-driven, not hardcoded business invariants.

## Correctness Guarantees

### Onchain guarantee

A collection should be considered ownership-correct once:

- metadata snapshot completed
- ownership snapshot completed
- short backfill completed
- `collections.status = live`

### OpenSea guarantee

A collection should be considered OpenSea-ready once:

- slug resolution succeeded
- initial snapshot succeeded
- `collections.opensea_status = ready`

Stream health is tracked separately. Stream degradation does not unset OpenSea readiness; reconcile is the recovery path.

## Eventual Consistency Note

OpenSea snapshot/reconcile completion is currently queue-publication completion, not a guarantee that every published order has already completed downstream validation.

That tradeoff is intentional for now:

- source-complete data is published quickly
- canonical order rows and validation converge through the queue pipeline shortly after

## Relevant Tables

Bootstrap and OpenSea lifecycle state is tracked primarily in:

- `collections`
- `nft_balance_snapshots`
- `opensea_orderbook_runs`
- `offchain_order_observations`

## Relevant Queues and Workers

Queues:

- `collection-bootstrap`
- `events-sync-backfill`
- `opensea-bootstrap`
- `opensea-reconcile`
- `offchain-orders-raw`

Workers:

- `bootstrap-worker`
- `sync-worker`
- `opensea-bootstrap-worker`
- `opensea-stream-worker`
- `opensea-reconcile-worker`
- `opensea-reconcile-scheduler-worker`
- `offchain-ingest-worker`
- `domain-worker`
