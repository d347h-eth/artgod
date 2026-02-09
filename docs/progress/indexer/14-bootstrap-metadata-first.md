# Bootstrap Metadata-First Pipeline

This document captures the bootstrap sequence and guarantees after switching to metadata-first bootstrap.

## Sequence

1. Pick a single shared anchor block (`head - reorgDepth`).
2. Enumerate ERC-721 token IDs at the anchor.
3. Run full metadata snapshot for all tokens (normalized writes + side-effects).
4. Run owner snapshot using the same token ID set and the same anchor.
5. Schedule short backfill from `anchor + 1` to current head.
6. Mark collection `live` once backfill is complete.

## Why Metadata First

The metadata phase can be the most failure-prone and operationally expensive step (bad URIs, slow gateways, invalid payloads).

Putting metadata first gives fail-fast behavior:

- In `strict` mode, bootstrap blocks early if metadata cannot complete.
- We avoid running owner snapshot/backfill before metadata feasibility is known.

This reduces redundant work and lets the user decide early whether to continue in strict mode or switch to best-effort.

## Consistency Model

A single shared anchor is used for both metadata and ownership snapshots.

This guarantees:

- Metadata and ownership baseline represent the same chain point.
- Post-anchor mutations are captured by short backfill.

This is required for mutable/onchain metadata collections where consistency between owner state and metadata state matters.

## Metadata Completion Modes

## `strict`

- Retries metadata snapshot failures indefinitely.
- Collection does not progress to owner snapshot/backfill until all metadata tasks succeed.

## `best_effort`

- Retries according to bootstrap metadata retry policy.
- After max attempts, token task is marked `failed_terminal`.
- Collection can continue once all tasks are either `succeeded` or `failed_terminal`.
- Terminal failures are persisted for future manual reprocessing.

## Failure Tracking

Bootstrap metadata progress and failures are persisted in `bootstrap_metadata_snapshot_tasks`.

This table is the source-of-truth for:

- Snapshot progress (`pending`, `retry`, `succeeded`, `failed_terminal`).
- Retry counters and scheduling (`attempts`, `next_attempt_at`).
- Error history (`last_error`, `last_error_at`).

Future API/UI work will expose these rows and allow manual retry workflows.

## Current Constraints

- ERC-721 only.
- Assumes archive-node-grade RPC availability for long anchored bootstrap steps.
- Runtime ownership fallback is still out of scope; `nft_balances` remains canonical after bootstrap.
