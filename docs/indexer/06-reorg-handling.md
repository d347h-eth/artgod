# Reorg Handling

The reorg worker verifies pending stored block hashes and retains known mismatches
until ancestor proof, atomic rollback and canonical resync resolve them. SQLite
owns unfinished checks from the block commit onward, including across downtime.

Primary file:

- `indexer/src/runtime/reorg-worker.ts`

Supporting files:

- `indexer/src/domain/canonical-check.ts`
- `indexer/src/ports/canonical-checks.ts`
- `indexer/src/infra/storage/sqlite-canonical-checks.ts`
- `indexer/src/application/reorg-fork.ts`
- `indexer/src/application/reorg-rollback.ts`
- `indexer/src/application/reorg-recovery.ts`
- `indexer/src/domain/reorg-recovery.ts`
- `indexer/src/infra/storage/sqlite-reorg-recoveries.ts`
- `indexer/src/infra/ownership/rpc-rollback-snapshot.ts`
- `indexer/src/infra/storage/sqlite.ts`

## Pending Hash Checks

Every sync range records the observed RPC HEAD before fetching blocks. Saving a
block newer than `HEAD - REORG_DEPTH + 1` sets `blocks.canonical_check_pending`
inside the same transaction as its facts, coverage and required follow-ups.
Already mature historical imports need no delayed check. Repeated imports of the
same hash preserve an unfinished check and never rearm a completed one.

The existing depth convention is unchanged: block N becomes eligible when HEAD
reaches `N + REORG_DEPTH - 1`. This delays only verification; realtime data is
fetched and saved immediately. Pending rows remain eligible after they age beyond
today's realtime window. The scheduler neither schedules nor tracks these checks;
there is no hash-check queue, message or broker consumer.

For each eligible row, the reorg worker:

1. Captures the stored chain, height, hash and chain revision.
2. Fetches the canonical header freshly, bypassing the block cache.
3. On a match, clears the pending flag conditionally on that identity and revision.
4. On a mismatch, retains recovery and clears the pending flag in one transaction.
5. Attempts ancestor verification and rollback through the existing recovery flow.

RPC, wrong-height responses, checkpoint/header reads and retention failures leave
the check pending. `canonical_check_retry_at` supplies durable backoff with no
delivery-count limit or DLQ. A failed check does not prevent another eligible row
from being checked. Rollback deletes checks with their orphaned block rows;
replacement recent blocks retain their own checks when saved.

## Durable Recovery Lifecycle

`chain_reorg_recoveries` retains at most one unfinished workflow per chain:

- `awaiting_ancestor` holds the lowest known mismatched height and retry
  eligibility. Later checks coalesce; an earlier mismatch supersedes stale proof.
- `resync` holds one bounded required range, a captured target head, the committed
  revision. A transaction committing its data and required downstream publication
  intent advances this phase; coverage or broker acceptance alone does not.

The reorg runtime resumes due recovery before reading pending checks. It drains
eligible checks one at a time, yielding between them, and polls every 12 seconds
when idle or waiting. The sync runtime executes retained resync continuously
through its automatic executor, independently of head changes. Failed checks,
acquisition and proof retry after five minutes. Proof errors remain visible in
logs and persisted `last_error`;
no ancestor guess or hot retry loop is used. Missing-header gap repair can make
later proof succeed even when HEAD stays unchanged.

A newer mismatch during resync carries the earliest unacquired resync block into
its replacement workflow. Stale proof cannot commit over a newer recovery or
chain revision. A changed revision rearms proof while preserving that unfinished
range rather than retrying a permanently stale checkpoint.

## Fork Point Search

The fork point search (`findCommonAncestor()`):

- Captures the sparse local headers and chain revision over the entire
  `reorgDepth` window through the mismatched block in one read transaction.
- Reads a fresh, parent-linked canonical RPC window and rechecks its tip, reusing
  the sync pipeline's header acquisition contract.
- Compares every stored header and parent identity. A parent mismatch can reveal
  divergence at a height whose local header is missing.
- Returns the most recent matching stored header below every observed divergence,
  together with its local history evidence. A canonical header inserted by gap
  repair above an earlier orphan cannot authorize an incomplete rollback.
- Returns `null` when no such header exists inside the bound. Recovery remains
  pending without changing facts, balances or revision. Gap repair can still fill
  missing proof headers; ancestor search does not reject those sparse repairs.

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
current and that the complete local proof window is unchanged, including newly
filled holes and parent metadata. It writes the fork ownership checkpoints (including absent tokens), removes
orphaned facts and coverage, advances the chain sync revision, retains resync
progress. Failure retaining the resync state rolls back every part of the
transaction. RPC remains outside the
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

The workflow retains one range capped by `BACKFILL_BATCH_SIZE`. The sync worker's
`AutomaticSyncExecutor` reads it directly, reloads live and bootstrapping
collections through the existing backfill selection after entering the
current-state gate, and uses the shared sync pipeline. Selection does not require
a bootstrap anchor; current-state projection remains anchor-gated. An empty
eligible set leaves recovery pending.

One transaction revalidates recovery ID, revision and exact range; persists
canonical data/coverage/balances; retains every required follow-up in the outbox;
and advances the next bounded range or clears recovery. Failure in any part
leaves the previous range intact. A crash before commit retries acquisition;
a crash afterward retries publications from the outbox without another RPC read.
No automatic range publication, broker lease, delivery generation or continuation
message is needed. Old queued `reorg_recovery` hints are ACKed without acquisition.

The domain worker retries required publications indefinitely with capped backoff
and stable, revision-qualified IDs. Acquisition completion means publication
intent is durable; it does not mean the broker or domain consumers have finished.
Rollback drops orphan event-specific intent, and domain consumers reject already
published event hints whose originating block hash is no longer stored. Pending
range follow-ups survive rollback because they reread canonical persisted facts;
this also preserves unfinished pre-fork projection when a newer mismatch occurs.
Event-triggered metadata range continuations retain that block identity and the
revision-qualified root publication ID through every cursor. Replacement tails
therefore remain distinct from tails already accepted for an orphaned root.

A head behind the verified fork defers rollback. If the head is exactly the fork
and no interrupted earlier acquisition remains, rollback completes recovery
without inventing a range. A newer mismatch or revision change rearms bounded
proof and preserves the earliest unacquired range.

Normal composition requires the reorg worker for proof/rollback, sync worker for
acquisition, and domain worker for outbox publication. Restart does not repeat a
committed rollback. Realtime remains outside the backfill gate; transaction-time
revision checks reject pre-rollback RPC results. Full pause/shutdown/purge
coordination for already admitted work remains deferred.

## Safety Rules

- The worker never schedules ranges that start at or below block 0.
- If no common ancestor is verified, keep recovery pending and warn.
- Rollback crossing a settled collection bootstrap anchor is refused. Automatic
  recovery of that case is outside the current contract; purge and rebootstrap
  the affected collection.

## Current Limits and Future Direction

Pending checks provide one delayed verification for blocks saved before maturity.
There are no medium- or long-horizon rechecks of completed blocks. A reorg deeper
than the configured confirmation depth remains outside this guarantee. Any future
tiers must preserve bounded ancestor search and idempotent retained resync.

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
and an atomic checkpoint/rollback commit without RPC inside the writer. Durable
check/recovery ownership and conditional commits are correctness requirements
independent of throughput.
