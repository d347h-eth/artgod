# Reorg Handling

The reorg worker verifies recently persisted blocks and rolls back when the local chain diverges from the RPC chain.

Primary file:

- `indexer/src/runtime/reorg-worker.ts`

Supporting files:

- `indexer/src/domain/reorg-jobs.ts`
- `indexer/src/application/reorg-fork.ts`
- `indexer/src/application/reorg-rollback.ts`
- `indexer/src/infra/ownership/rpc-rollback-snapshot.ts`
- `indexer/src/infra/storage/sqlite.ts`

## Block-Check Jobs

Block-check jobs are published by the scheduler-worker after a block is at least `reorgDepth` behind the current head. Each job contains:

```
{ blockNumber: number }
```

These jobs are consumed by the reorg worker on the `block-check` queue.

## Block Check Flow

When a block-check job is received:

1. Validate `blockNumber` is positive.
2. Load the stored block hash from the database.
3. Fetch the canonical block from RPC, bypassing the block cache.
4. If hashes match, the block is confirmed.
5. If hashes differ, find the fork point and roll back.

## Fork Point Search

The fork point search (`findCommonAncestor()`):

- Walks backwards from the mismatched block up to `reorgDepth` blocks.
- Compares stored block hashes to fresh RPC block hashes.
- Skips missing local headers and continues searching; missing history does not
  establish a common ancestor.
- Returns the most recent matching block.
- If no stored header matches within the bounded search, returns `null` and leaves
  local state untouched.

## Rollback Strategy

If a fork point is found:

- Roll back from `forkPoint + 1` in SQLite.
- Delete blocks, transfer events, and activity rows from the rollback block onward.
- Delete metadata rows tied to orphaned blocks.
- Delete on-chain orders created in orphaned blocks.
- Best-effort reset of orders invalidated by rolled-back transfers.
- Restore affected ERC721 owners from `ownerOf` reads pinned to the fork block.
- Reverse ERC1155 balance deltas using the orphaned transfer history.
- Delete persisted transactions for orphaned blocks.

`RollbackChainRange` first prepares the distinct affected ERC721 tokens, including
tokens known only through a previous ownership checkpoint. The RPC adapter reuses
bootstrap's token ownership reader and verifies the fork block hash before and
after the reads. Unknown RPC failures leave local state untouched; a recognized
nonexistent-token revert establishes absent ownership.

One SQLite transaction validates that the rollback plan is still current, writes
the fork ownership checkpoints (including absent tokens), removes orphaned facts
and coverage, and advances the chain sync revision. A sync worker captures that
revision before fetching RPC data; work fetched before a committed rollback is
rejected when it tries to persist. An affected token added while RPC reads are in
progress also invalidates the rollback plan and requires a fresh attempt.

Fork checkpoints describe ownership at the end of their block. Historical repair
facts at that block or earlier cannot replace the checkpoint; newer transfers
can. This keeps ownership correct even when the rollback encountered missing
history and canonical resync produces no transfer events. Bootstrap finalization
replaces the collection's checkpoints along with its ownership snapshot.

## Resync After Rollback

After rollback, the worker schedules backfill jobs for the range:

```
rollbackFrom -> currentHead
```

The backfill jobs use the same `events-sync-backfill` queue as manual backfills and are processed by the sync worker.

## Safety Rules

- The worker never schedules ranges that start at or below block 0.
- If no common ancestor is verified, rollback is skipped with a warning.

## Current Limits and Future Direction

Block-check cadence is scheduler-owned. Checks are not yet persisted beside the
block write or separated into delayed short-, medium-, and long-horizon tiers.
Any future change must retain ordered fork discovery, bounded rollback depth,
and idempotent resync through the existing backfill queue.

### Deferred Ownership Workload Scaling

Rollback prepares all distinct affected ERC721 tokens and reads owners serially
outside the SQLite writer. Large-token RPC latency and memory cost have not been
qualified by the local storage rollback measurements. Configurable concurrency
is deferred under the existing `BKL-037` ownership-scaling item in the
[unified backlog](../planning/01-unified-backlog.md); see also
[bootstrap ownership scaling](17-bootstrap-execution-and-concurrency.md#deferred-anchored-ownership-reuse).

Measure affected-token count, RPC latency, rate-limit pressure, and memory before
choosing bounded read batches or a worker pool. Any future scaling must preserve
one exact fork identity, absence/error classification, plan/revision fencing,
and an atomic checkpoint/rollback commit without RPC inside the writer. Broker
lease renewal and idempotent redelivery are correctness requirements independent
of throughput; their recovery fixes are not deferred by this performance work.
