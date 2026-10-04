# Reorg Handling

The reorg worker verifies recently persisted blocks and retains known mismatches
until ancestor proof, atomic rollback and canonical resync resolve them. Queue
delivery is a wakeup; SQLite owns unfinished recovery after mismatch retention.

Primary file:

- `indexer/src/runtime/reorg-worker.ts`

Supporting files:

- `indexer/src/domain/reorg-jobs.ts`
- `indexer/src/application/reorg-fork.ts`
- `indexer/src/application/reorg-rollback.ts`
- `indexer/src/application/reorg-recovery.ts`
- `indexer/src/domain/reorg-recovery.ts`
- `indexer/src/infra/storage/sqlite-reorg-recoveries.ts`
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
5. If hashes differ, persist a recovery identity with the observed hashes,
   checked height and captured chain revision before relinquishing the delivery.
6. Attempt due ancestor proof and rollback. An unavailable proof remains pending.

If initial mismatch retention fails, `JobDeferred` keeps the original check
retryable even beyond the ordinary worker DLQ budget: no durable business owner
exists yet. Once retained, recovery failures can be acknowledged or dead-lettered
without forgetting the pending workflow. The reorg consumer renews its broker
lease every 10 seconds through `runWorker`; identity, revision and token-scope
fences still protect against duplicate delivery.

## Durable Recovery Lifecycle

`chain_reorg_recoveries` retains at most one unfinished workflow per chain:

- `awaiting_ancestor` holds the lowest known mismatched height and retry
  eligibility. Later checks coalesce; an earlier mismatch supersedes stale proof.
- `resync` holds one bounded required range, a captured target head, the committed
  revision and a delivery generation. Coverage or queue acceptance does not
  complete this phase.

The reorg runtime resumes due work at startup and polls every 12 seconds,
independently of scheduler head updates. Failed proof and unfinished resync retry
after five minutes. Proof errors remain visible in logs and persisted `last_error`;
no ancestor guess or hot retry loop is used. Missing-header gap repair can make
later proof succeed even when HEAD stays unchanged.

A newer mismatch during resync carries the earliest unfinished fanout block into
its replacement workflow. Stale proof cannot commit over a newer recovery or
chain revision. A changed revision rearms proof while preserving that unfinished
range rather than retrying a permanently stale checkpoint.

## Fork Point Search

The fork point search (`findCommonAncestor()`):

- Walks backwards from the mismatched block up to `reorgDepth` blocks.
- Compares stored block hashes to fresh RPC block hashes.
- Skips missing local headers and continues searching; missing history does not
  establish a common ancestor.
- Returns the most recent matching block.
- If no stored header matches within the bounded search, returns `null`. The
  recovery remains pending; facts, balances and chain revision stay untouched.

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
tokens known only through a previous ownership checkpoint. Ancestor discovery
passes the verified chain ID, height, hash and header into rollback preparation.
The consolidated bootstrap/rollback ownership reader uses `readContractAtBlock`,
whose RPC adapter sends EIP-1898 `eth_call` with that exact `blockHash` and
`requireCanonical: true`. Every endpoint retry retains the hash; an unsupported,
unavailable or noncanonical block is a failure, never a height-only fallback or
token absence. Fresh header checks before and after the reads also verify the
requested fork. Unknown RPC failures leave local state untouched; only a
recognized nonexistent-token revert establishes absent ownership.

One SQLite transaction validates that the recovery and rollback plan are still
current, writes the fork ownership checkpoints (including absent tokens), removes
orphaned facts and coverage, advances the chain sync revision, retains resync
progress and enqueues its first range in `queue_outbox`. Failure retaining that
continuation rolls back every part of the transaction. RPC remains outside the
writer. A sync worker captures the chain
revision before fetching RPC data; work fetched before a committed rollback is
rejected when it tries to persist. An affected token added while RPC reads are in
progress also invalidates the rollback plan and requires a fresh attempt.

Fork checkpoints describe ownership at the end of their block. Historical repair
facts at that block or earlier cannot replace the checkpoint; newer transfers
can. This keeps ownership correct even when the rollback encountered missing
history and canonical resync produces no transfer events. Bootstrap finalization
replaces the collection's checkpoints along with its ownership snapshot.

## Resync After Rollback

Rollback captures the current head and starts resync over:

```
rollbackFrom -> currentHead
```

The workflow retains one range capped by `BACKFILL_BATCH_SIZE`. The existing
domain-worker outbox drainer publishes it to `events-sync-backfill`, and the sync
worker uses the normal range persistence and downstream fanout pipeline. The
matching recovery/range advances only after both succeed, atomically retaining
the next range and its outbox job. It clears after the last required range;
downstream publication is established, not completion by those domain consumers.

A head behind the verified fork defers rollback. If the head is exactly the fork
and no interrupted earlier range remains, the atomic rollback completes recovery
without inventing a resync range.

`reorg_recovery` jobs explicitly carry `{ recoveryId, revision }`, are chain-wide
and select `current_state`. Stale, legacy unowned, collection-scoped or incorrectly
configured reorg jobs cannot complete a workflow. Eligible collections are
reloaded inside the current-state gate. An empty eligible set leaves resync
pending. Already admitted work retains existing lifecycle behavior; full
pause/shutdown/purge coordination remains deferred.

If no completion arrives within five minutes, recovery replaces its retained
outbox publication with a fresh delivery generation for the same logical range.
This also redrives `failed_terminal`, sent-but-unfinished, ACKed and DLQ deliveries.
Transport IDs change to avoid broker deduplication swallowing required work;
recovery ID, revision and range remain its completion identity. An older delivery
may complete the same current range; a completed or superseded range is a no-op.
Unfinished broker messages can coexist, while retained business/outbox work stays
bounded to one range per chain.

Normal composition requires the reorg worker (continuation owner), domain worker
(outbox publisher) and sync worker (range and fanout completion). Restart after
rollback resumes resync without repeating the committed rollback. Realtime work
remains outside the backfill gate; transaction-time revision checks reject its
pre-rollback RPC result.

## Safety Rules

- The worker never schedules ranges that start at or below block 0.
- If no common ancestor is verified, keep recovery pending and warn.
- Rollback crossing a settled collection bootstrap anchor is refused. Automatic
  recovery of that case is outside the current contract; purge and rebootstrap
  the affected collection.

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
