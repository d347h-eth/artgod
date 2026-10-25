# Reorg Handling

The sync coordinator verifies pending stored block hashes and retains known mismatches
until ancestor proof, atomic rollback and canonical resync resolve them. SQLite
owns unfinished checks from the block commit onward, including across downtime.

Primary file:

- `indexer/src/runtime/sync-worker.ts`

Supporting files:

- `indexer/src/domain/canonical-check.ts`
- `indexer/src/ports/canonical-checks.ts`
- `indexer/src/infra/storage/sqlite-canonical-checks.ts`
- `indexer/src/infra/storage/sqlite-canonical-headers.ts`
- `indexer/src/application/reorg-fork.ts`
- `indexer/src/application/reorg-rollback.ts`
- `indexer/src/application/reorg-recovery.ts`
- `indexer/src/domain/reorg-recovery.ts`
- `indexer/src/infra/storage/sqlite-reorg-recoveries.ts`
- `indexer/src/infra/ownership/rpc-rollback-snapshot.ts`
- `indexer/src/infra/storage/sqlite.ts`

## Pending Hash Checks

Every sync range records the observed RPC HEAD before fetching blocks. Saving an
accepted recent block newer than `HEAD - REORG_DEPTH + 1` sets `blocks.canonical_check_pending`
inside the same transaction as its facts, coverage and required follow-ups.
Already mature historical imports need no delayed check. Repeated imports of the
same hash preserve an unfinished check and never rearm a completed one.

Order validation consumes a checkpoint selected from the sync coordinator's
contiguous applied chain and collection progress. Validation never inserts headers
or advances sync progress. Its committed proof retains that checkpoint's block
identity and revision; a conflicting fresh read retains a dispute for coordinator
recovery.

An explicit disagreement with a stored header during sync or validation rearms verification
even for mature history or a completed check. The owning commit boundary retains
that check outside its failed writer transaction, fenced by the stored hash
and chain revision. Explicit disputes gate progress and become due immediately;
ordinary retained checks preserve backoff. A generation fences confirmation RPC
already in flight when another conflict arrives. The sync request remains
pending until the coordinator freshly verifies and,
when needed, recovers the conflicting history.

The existing depth convention is unchanged: block N becomes eligible when HEAD
reaches `N + REORG_DEPTH - 1`. This delays only verification; the coordinator applies the next required prefix
without waiting for maturity. Pending rows remain eligible after they age beyond
today's realtime window. The scheduler neither schedules nor tracks these checks;
there is no hash-check queue, message or broker consumer.

For each eligible row, the sync coordinator:

1. Captures the stored chain, height, hash and chain revision.
2. Fetches the canonical header freshly, bypassing the block cache.
3. On a match, clears only the captured check generation, repairs any source
   barrier at that height, and removes that dispute gate. Other disputes and
   retained recovery remain gated.
4. On a mismatch, retains recovery and clears the pending flag in one transaction.
   Its individual dispute remains retained, including when an earlier mismatch
   already owns the recovery journal.
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

The sync coordinator resumes due recovery and reads pending checks in the same
serial executor that applies forward ranges. It polls every 12 seconds when idle
or waiting and executes retained resync independently of head changes. Failed checks,
acquisition and proof retry after five minutes. Proof errors remain visible in
logs and persisted `last_error`;
no ancestor guess or hot retry loop is used. Recovery acquires replacement
headers independently of forward ingestion. Missing accepted local lineage
remains an invariant failure; historical gap repair does not manufacture proof
of the old branch.

Fresh proof may also establish that the complete accepted window agrees again.
That outcome does not require rollback: the recovery writer preserves accepted
facts, collection checkpoints and chain revision. It atomically returns every retained
individual dispute to the existing canonical checks and preserves any interrupted
resync range. Progress stays gated until fresh generation-fenced checks confirm
those identities. This includes later disagreements coalesced into the earlier
journal and new disputes arriving during proof RPC; agreement at the original
checked height cannot silently discharge either one. Restart resumes the same
retained checks and acquisition.

A newer mismatch during resync carries the earliest unacquired resync block into
its replacement workflow. Stale proof cannot commit over a newer recovery or
chain revision. A changed revision rearms proof while preserving that unfinished
range rather than retrying a permanently stale checkpoint.
Due canonical checks continue while recovery is retained, including deferred
ancestor proof and resync. A conflicting stored identity cannot wait for the
resync it prevents from completing.

## Recovery Decision Logs

`RecoverChainReorg` emits three structured decisions under `component=ReorgRecovery`.
The action values belong to `REORG_RECOVERY_LOG_ACTION` in
`indexer/src/domain/reorg-recovery.ts`:

- `mismatch_retained` (warn): emitted after mismatch retention succeeds. Includes
  the chain/recovery ID, checked height, stored and observed hashes, and revision.
  It records the RPC disagreement; ancestor verification still has to succeed.
- `rollback_committed` (info): emitted after the atomic rollback/resync transaction
  succeeds. Includes the retained mismatch, verified fork height/hash, rollback
  start, captured HEAD, full resync bounds/count, first batch end, configured batch
  size, affected ERC721 token count, and revisions before/after rollback.
- `agreement_restored` (info): emitted after an agreeing history window returns
  its disputes to canonical checks. Includes the chain/recovery ID, checked
  height, unchanged revision and any retained resync bounds.

`forkToCheckedBlocks` is the distance from the verified fork to the checked height,
not a measured total of orphaned chain blocks. `resyncBlocks` is the complete
refill range; it can include already canonical blocks and downtime gaps. Resync
may start before the rollback boundary when it preserves unfinished earlier
work. A fork-only rollback with no remaining work records null resync bounds and
zero blocks. Failed transactions never emit a committed decision, and ordinary
matching checks add no log volume.

These records retain the decision context in logs after completed recovery state
is removed from SQLite. See the
[Loki queries](10-observability-and-metrics.md#log-pipeline) for bounded inspection.

## Fork Point Search

The fork point search (`findCommonAncestor()`):

- Captures the chain revision and complete connected retained window through
  the mismatched block in one read transaction. Initialization retains a linked
  predecessor window below the first shared applied block, so that starting
  height is not a recovery veto. The configured `reorgDepth` still bounds search.
- Rejects holes, parent mismatches, and a checked height beyond the shared
  applied tip before making replacement RPC calls. A retained check below the
  initial applied base is supported only when its history connects to that base.
- Reads the same clamped window from fresh, parent-linked canonical RPC headers
  and rechecks its tip, reusing sync's header acquisition contract.
- Returns the nearest matching ancestor below every observed divergence,
  together with its captured local history evidence.
- Distinguishes complete restored agreement from a divergence. A fully matching
  window, including a single accepted-base header, does not invent an earlier
  fork or require rollback.
- Returns `null` when no matching ancestor exists within the retained window.
  Missing or deeper-than-retained ancestry keeps recovery pending; it never
  guesses a fork or resets the chain from an unproven replacement snapshot.

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
current and that the complete connected local proof window and its parent
metadata remain unchanged. It fails all in-flight bootstrap runs on the chain,
revokes their step leases, and clears their derived collection output. A collection
that is already live, including one retrying metadata on its completed bootstrap
run, is invalidated only when its ownership anchor is orphaned. Invalidated
collections return to `prepared` and require a fresh bootstrap; configuration,
failed-run diagnostics, trading declarations and cancellation obligations remain.
Price tiers survive unconditionally, including unused tiers and collections with
no jobs; their graphs, saved job prices, commands and operator settings are not
chain-derived state. The shared collection cleanup owner also serves explicit
operator purge, which separately removes both declarations and derived data.

The transaction writes the fork ownership checkpoints for surviving collections
(including absent tokens), removes
orphaned facts and coverage, advances the chain sync revision, retains resync
progress. Failure retaining the resync state rolls back every part of the
transaction. RPC remains outside the
writer. A sync worker captures the chain
revision before fetching RPC data; work fetched before a committed rollback is
rejected when it tries to persist. An affected token added while RPC reads are in
progress also invalidates the rollback plan and requires a fresh attempt.

Fork checkpoints describe ownership at the end of their block. Historical facts
cannot replace the checkpoint. Only later transfers accepted through the
collection prefix can update current ownership. This keeps ownership correct even when the rollback encountered missing
history and canonical resync produces no transfer events. A verified ancestor
below the original shared starting block rewinds that starting point as well.
No collection snapshot can veto an otherwise proven chain rollback. Bootstrap
metadata, ownership, image and extension outputs check their current run in
their final writer. Ordinary metadata and extension output also compare the
collection lifecycle, anchor, current run and chain revision captured before
acquisition. A response arriving after invalidation cannot recreate removed
data; valid paused collections and explicit Backfill work can still finish
enrichment.

Signed Seaport declarations are retained when their protocol result is orphaned.
The rollback writer marks those results `unvalidated`, removes their funded
capacity and retains validation demand against the new fork. It also rebinds
pending orphaned block requirements. The ordinary demand executors revalidate
them without REST reconciliation. Source observations remain separate from canonical terminality. Rollback
invalidates orphaned chain proof; source availability neither restores that proof
nor independently declares protocol completion. Certified surviving proofs below
the fork are rebound to the new revision inside the same writer; old in-flight
validation claims are not.

Before rebinding proofs, that same transaction transfers pending canonical maker
requirements to the new revision and fences old leases. Surviving passes keep
their finite boundaries, cursors and delivery receipts. Maker requirements
coalesce event heights, so an orphaned maximum may hide an earlier surviving
invalidation. Rollback conservatively caps that requirement at the exact verified
ancestor; it does not discard the scope or reconstruct event history. A surviving
older pass retains a full follow-up when the ancestor is later than its current
requirement. An already promoted orphaned pass keeps its cursor: earlier pages
are covered by rollback's ordinary-demand reconciliation, while remaining pages
use the ancestor requirement. This may cause an unnecessary revalidation when
all events were orphaned, but cannot expose an uncovered old proof. The helper
pages maker runs inside the existing writer; it adds no executor or per-order scan.
See [order quantities](07-domain-orders.md#partial-fills-and-quantities).

## Resync After Rollback

Rollback captures the current head and starts resync over:

```
rollbackFrom -> currentHead
```

The workflow retains one shared range capped by `BACKFILL_BATCH_SIZE`. The
coordinator acquires its next shared prefix on the main lane, even when no
collection is currently eligible or historical gap filling is disabled. Its
transaction validates recovery identity, revision and predecessor, applies shared
protocol effects, retains follow-ups, and advances the range or clears recovery.
Collections independently replay their missing accepted prefix afterward; a
paused collection catches up when resumed. Validation for a collection remains
limited to both its own and shared progress.

A crash before commit retries acquisition; a crash afterward retries publications
from the outbox without another RPC read. No automatic range publication, broker
lease, delivery generation or continuation message owns recovery. The queue
decoder accepts only current manual/bootstrap requests; it has no automatic
recovery payload.

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

The sync runtime owns proof, rollback and acquisition through one transition
gate; the domain runtime publishes retained outbox work. Restart does not repeat
a committed rollback. Transaction-time revision checks reject pre-rollback RPC
results. Full pause/shutdown/purge coordination for already admitted work remains
deferred.

## Safety Rules

- The worker never schedules ranges that start at or below block 0.
- If no common ancestor is verified, keep recovery pending and warn.
- An ownership snapshot is subordinate to verified chain history. Crossing its
  anchor invalidates that collection instead of blocking recovery for every
  collection on the chain. Rebuilding the collection requires a new bootstrap;
  recovery does not attempt automatic ownership resnapshotting.
- Failed/replaced bootstrap runs cannot publish late output. Cleanup and run
  invalidation commit with rollback, or none of those transitions commit.
- A fork beyond the retained connected lineage or configured search depth
  remains unsupported. This limit does not make a bootstrap anchor authoritative
  over a verified ancestor.

Current order results retain an independent proof height/hash, chain revision,
order revision and admission sequence, separately from lifecycle provenance and
demand lease cleanup. A trigger-only rollback may clear
request coverage while retaining a pre-fork result; a later deeper rollback must
still invalidate that result from its own attribution. Terminal retirement requires evidence supporting terminality; an earlier
fillable validation cannot provide sale attribution. Source availability has its
own provenance and cannot become a canonical retirement fact.

## Current Limits and Future Direction

Pending checks provide one delayed verification for blocks saved before maturity.
There are no medium- or long-horizon rechecks of completed blocks. A reorg deeper
than the configured confirmation depth remains outside this guarantee. Any future
tiers must preserve bounded ancestor search and idempotent retained resync.

### Deferred Chain Recovery Instrumentation

`BKL-074` (review finding RS-01) is explicitly deferred. The system does not yet
provide general recovery tooling for conflicts older than its supported
`REORG_DEPTH` window. For example, disconnected historical headers at 497–499
with accepted chain progress starting at 900 can retain a disagreement that
normal recovery cannot prove through connected ancestry. Provider agreement
returning, including after restart, does not by itself resolve that state.

Future explicit chain recovery tooling should expose the disputed block/hash,
accepted checkpoints, missing ancestry and blocked processing, then provide a
reviewable recovery procedure appropriate to that evidence. It must distinguish
restored agreement from a real deep fork and preserve operator declarations.
Neither clearing a gate without proof nor guessing an ancestor is acceptable.
This is deferred instrumentation and recovery work, not an automatic repair
added to the current bootstrap/validation corrections.

### Lineage and admission retention

Normal maintenance does not prune canonical headers. This existing unbounded
header retention preserves initialization predecessors, shared/collection anchors, accepted prefixes, ordinary
proof identities, pending checks and unfinished recovery windows. HEAD advancing
cannot remove the ancestor window of an older unfinished check. Adding header
pruning requires an explicit retention design for all of those dependencies.

Remote head samples have a separate bounded cleanup pass. It retains the latest
current-revision watermark, exact mappings for pending order admissions, unexpired
validation claims, and both admission generations of pending maker scopes.
Committed proofs retain their own admission scalar and canonical block identity;
they do not need their old remote sample mapping. Cleanup examines at most 500
samples per batch, resumes through a durable cursor, and shares the existing
market-data maintenance cadence. Pins are rechecked in the deletion writer.

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

### Deferred Order Rollback Scaling

The order invalidation helper pages results inside the atomic rollback writer;
those pages bound memory, not writer duration. A local copied-instance workload
with 237,620 retained orders took 6.88–8.71 seconds for staged bulk invalidation.
At fourfold volume, rollback through commit took 45.48 seconds and a competing
ordinary writer exhausted its retry budget after 15.05 seconds. State assertions
passed; the reproduced limitation is writer availability.

The user deferred the redesign under `BKL-073`. See the
[investigation record](../development/05-order-reorg-rollback-investigation.md)
for all measurements, workload boundaries, preserved evidence, and the coarse
reset, whole-chain generation, and selective-fence alternatives. These are
proposals; current rollback semantics above remain implemented.
