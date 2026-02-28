# Collection Bootstrap (Ownership Snapshot + Short Backfill)

This document describes the intended per-collection bootstrap sequence. The goal is to reach a correct, production‑quality ownership state **without** requiring a full historical backfill.

## Why Bootstrap Exists

`nft_balances` is the canonical "current ownership" table, but it is only correct when:

1. We have a snapshot anchored to a specific block, **plus**
2. We have processed every transfer after that block with no gaps.

Full backfill from genesis also works, but is too expensive for normal usage.

## Lifecycle Overview

Each collection starts in a "not indexed" state. When a user adds a collection, the indexer runs a deterministic bootstrap pipeline:

1. **Register collection**
    - Persist collection config (address, chain, optional metadata).
    - Store state in the `collections` table with `status = bootstrapping`.
    - Create internal state record for bootstrap progress.
    - Enqueue a `bootstrap.collection.start` job to begin orchestration.

2. **Pick anchor block**
    - Choose a recent block number (near head) as the snapshot anchor.
    - Current implementation uses `head - reorgDepth` to avoid shallow reorgs.
    - This block number becomes the "truth point" for ownership.

3. **Ownership snapshot (anchor)**
    - Query the chain at the anchor block:
        - **ERC-721 only**: `ownerOf(tokenId)` for every token.
        - Token IDs are enumerated via `totalSupply()` + `tokenByIndex()` (ERC721Enumerable).
    - ERC-1155 and ERC-20 support are **out of scope for now**.
    - Persist snapshot rows to a dedicated table (`nft_balance_snapshots`).
    - Snapshot data is **read‑only** and used as the base truth.

4. **Short backfill (anchor → head)**
    - Backfill from `anchorBlock + 1` to current head.
    - Apply deltas so `nft_balances` reflects the current state.
    - This range is small, so it finishes quickly.
    - Bootstrap worker schedules the backfill range and periodically checks
      `blocks` table completeness before marking the collection live.

5. **Live sync**
    - Switch the collection to realtime indexing (`status = live`).
    - `nft_balances` now stays correct from this point forward.

6. **Optional full historical backfill (later)**
    - Only if the user explicitly requests it.
    - Used for complete historical analytics and long‑range charting.

## Correctness Guarantees

The indexer should only claim "correct ownership state" for a collection when:

- Snapshot is complete, and
- Short backfill (anchor → head) is complete.

While a bootstrap is running, ownership reads should be treated as **incomplete**:

- API responses should signal "bootstrap in progress" and/or pause ownership endpoints.
- Consumers should not assume `nft_balances` is correct until the bootstrap completes.

## Notes for Future Implementation

- Snapshot storage should remain separate from `nft_balances` so we can:
    - Keep anchored truth distinct from delta‑applied state.
    - Delete or ignore snapshot rows once `nft_balances` becomes fully consistent.
- The snapshot anchor block should be recorded and exposed in API responses so clients can reason about timing.

## Bootstrap Runtime

Bootstrap orchestration is handled by the collection bootstrap worker:

- Queue: `collection-bootstrap`
- Job kind: `bootstrap.collection.start`
- Runtime: `indexer/src/runtime/bootstrap-worker.ts`

The worker is responsible for sequencing the snapshot and short backfill steps for a collection.

Dev helper:

- `yarn workspace @artgod/indexer dev:bootstrap-trigger --address <0x...>`
  enqueues a `bootstrap.collection.start` job for manual testing.

## Collection Registry Table

Bootstrap state is tracked in SQLite:

- Table: `collections`
- Key columns:
    - `chain_id`, `collection_id`, `address`
    - `status` (`bootstrapping` or `live` today; future: `paused`, `disabled`)
    - `deployment_block` (metadata only)
    - `bootstrap_anchor_block` (anchor block for snapshot)
    - `bootstrap_started_at`, `bootstrap_finished_at`
    - `bootstrap_last_synced_block`

Realtime sync uses only `status = live`. Backfill jobs can include `bootstrapping` collections while their short-range bootstrap backfill runs.
