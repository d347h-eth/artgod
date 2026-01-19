# Reorg Handling

The reorg worker verifies recently persisted blocks and rolls back when the local chain diverges from the RPC chain.

Primary file:

- `indexer/src/runtime/reorg-worker.ts`

Supporting files:

- `indexer/src/domain/reorg-jobs.ts`
- `indexer/src/infra/storage/sqlite.ts`

## Block-Check Jobs

Block-check jobs are published by the scheduler after a block is at least `reorgDepth` behind the current head. Each job contains:

```
{ blockNumber: number }
```

These jobs are consumed by the reorg worker on the `block-check` queue.

## Block Check Flow

When a block-check job is received:

1. Validate `blockNumber` is positive.
2. Load the stored block hash from the database.
3. Fetch the canonical block from RPC.
4. If hashes match, the block is confirmed.
5. If hashes differ, find the fork point and roll back.

## Fork Point Search

The fork point search (`findForkPoint()`):

- Walks backwards from the mismatched block up to `reorgDepth` blocks.
- Compares stored block hashes to RPC block hashes.
- Returns the most recent matching block.
- If none match, returns a value before the minimum range to indicate an invalid fork.

## Rollback Strategy

If a fork point is found:

- Roll back from `forkPoint + 1` in SQLite.
- Delete blocks, transfer events, and activity rows from the rollback block onward.
- Reverse balance changes using the transfer history.
- Delete persisted transactions for orphaned blocks.

## Resync After Rollback

After rollback, the worker schedules backfill jobs for the range:

```
rollbackFrom -> currentHead
```

The backfill jobs use the same `events-sync-backfill` queue as manual backfills and are processed by the sync worker.

## Safety Rules

- The worker never schedules ranges that start at or below block 0.
- If a fork point calculation returns a negative value, rollback is skipped with a warning.
