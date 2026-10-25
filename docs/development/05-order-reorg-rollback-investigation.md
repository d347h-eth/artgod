# Order Reorg Rollback Investigation

Recorded 2026-10-18 on `fix/partial-fill-order-lifecycle` at
`6c358505a7ca613f5dbdc56ef3534c1d78ece27d`.

## Decision and Scope

The user deferred the order-rollback scalability redesign after reviewing these
measurements. It is retained as `BKL-073` in the
[unified backlog](../planning/01-unified-backlog.md). No proposed redesign below
is implemented or selected. The current atomic rollback remains in place;
deferral does not remove its measured writer-availability limitation or establish
unqualified merge/release readiness.

The objective is correctness after a verified reorg: orphaned protocol results
must stop influencing order decisions, and orphaned terminal evidence must not
block a valid order. Keeping historical validation state is not itself a product
requirement. The user explicitly accepts discarding derived state and does not
want legacy-data recovery machinery for alpha databases that can be wiped.

Read [reorg handling](../indexer/06-reorg-handling.md),
[order quantities and lifecycle](../indexer/07-domain-orders.md#partial-fills-and-quantities),
and [SQLite contention policy](02-sqlite-write-contention.md) first. This record
preserves a local performance investigation, not a new runtime contract.

## Existing Correctness Boundary

- A signed Seaport declaration is distinct from its protocol result. Original
  size, remaining size, and balance/allowance-funded capacity are separate.
- Full-only executions become terminal immediately. Partial or unknown
  executions admit durable validation demand while retaining the last usable
  result; a dependency failure does not establish exhaustion.
- OpenSea sale hints require canonical transaction inclusion before completing
  their validation obligation. Marketplace observations do not own chain truth.
- Verified result block attribution lives on the order independently of demand
  proof cleanup. Terminal retirement copies that attribution before deleting
  the order and demand. Independent source cancellation remains protected.
- Rollback advances the chain sync revision. Work captured before that rollback
  cannot commit afterward through the existing checkpoint guards.
- The current rollback atomically resets orphaned results to unvalidated,
  clears funded capacity, admits validation demand, rebinds orphaned pending
  requirements, and removes attributed orphan terminal retirement markers.
  Ordinary demand executors perform validation; REST reconciliation is not part
  of this lifecycle.

The independent correction review at `e1c5f9ee` reported PFR-01 through PFR-06
closed with 803 repository tests and 12 reviewer checks. These covered sale
inclusion, result provenance after demand cleanup, retirement provenance, parser
exhaustion, and shared protocol roles, including additional hardening.
`6c358505` subsequently centralized typed validation reasons in the orders domain,
separating bounded semantic reason from dynamic error details; 260 focused tests
passed, with a final 17-test Seaport rerun and type/docs/format checks. These are
earlier local results, not fresh full-suite, native, live-provider, or remote-CI
qualification of this performance record.

## Why the Writer Grows

`invalidateOrderValidationFromBlock` in
`indexer/src/infra/orders/sqlite-order-validation-demand.ts` is called inside
`SqliteStorage.rollbackFromBlock` in `indexer/src/infra/storage/sqlite.ts`.
All pages execute in that same synchronous write transaction.

Selection considers retained signed Seaport orders on the chain, excluding
source-cancelled orders. Eligible inactive, invalidated, and expired orders are
not inherently excluded. It resets orphaned materialized results and rebinds
pending requirements from the orphaned range, preserving a still-canonical
pre-fork result when only its newer request is orphaned. Terminal result
attribution remains authoritative after demand-proof cleanup.

For M selected orders and R orphaned results, the helper performs M demand
upserts plus R order updates: at most 2M logical row mutations. Other rollback,
index, cascade, and physical page writes are additional. The 100-result pages
bound memory, not transaction duration. The query plan uses ordered primary-key
range seeks and demand primary-key lookups without a per-page temporary sort;
it does not demonstrate quadratic behavior. A sparse match can still scan much
of the retained book while holding the writer.

## Captured Reference and Method

The user reported the app stopped. The database, WAL, and SHM were copied
together; profiling used read-only/query-only connections to a private copy.
Only disposable working copies were modified. Before/after metadata and SHA-256
checks verified the original three files unchanged, covering 10,099,793,920 bytes.
Tracked source and Git state remained unchanged during the benchmark.

- Chain 1, 14 collections, 237,620 retained orders, all signed Seaport.
- 237,609 demand rows: 160,581 completed and 77,028 pending.
- 127,138 source-cancelled orders excluded; 110,482 potentially eligible orders.
- Captured head 26,221,941; highest bootstrap anchor 26,221,516.
- Source schema 073; migration 074 applied only to the working copy. Only 25
  captured order rows had block attribution, so staged cases deliberately also
  model broadly populated attribution under the new lifecycle.
- Fourfold book: 950,480 orders, cloned actual signed payloads and source-state
  mix with deterministic new IDs. Those IDs are storage fixtures, not claims of
  cryptographically valid order hashes.
- Node 24.3.0, SQLite 3.53.1, WAL, synchronous NORMAL, normal 5-second busy timeout
  and three-attempt retry policy. Local warm caches; no cache flushing, service
  provisioning, broker, credentials, REST, or chain RPC.

Full rollback cases add synthetic fork headers above the captured head, avoiding
affected ownership/transfer work. They use production storage rollback and isolate
its order cost; they do not measure total deep-history recovery. Helper-only
controls use the recorded recent window starting at block 26,221,940.

A separate ready Node process attempts a tiny production-policy write after
the rollback writer acquires its transaction. The harness records its actual
completion or retry exhaustion and explicitly retries after release. Setup,
digests, payload comparison, and state assertions are outside rollback timing.

## Measurements

| Case                           | Retained orders | Order updates | Demand upserts | Rollback through commit | Competing write       |
| ------------------------------ | --------------: | ------------: | -------------: | ----------------------: | --------------------- |
| Recorded recent window         |         237,620 |           275 |            275 |                 2.206 s | 2.232 s, success      |
| Staged bulk                    |         237,620 |       106,050 |        109,353 |                 8.713 s | 8.249 s, success      |
| Staged bulk repeat             |         237,620 |       106,050 |        109,353 |                 6.885 s | 6.447 s, success      |
| Successive deeper fork         |         237,620 |         4,432 |        110,481 |                 3.372 s | 3.332 s, success      |
| Fourfold staged bulk           |         950,480 |       424,200 |        437,412 |                45.475 s | 15.050 s, SQLITE_BUSY |
| Fourfold recorded distribution |         950,480 |         1,100 |          1,100 |                 3.354 s | 3.346 s, success      |

The fourfold bulk body took 41.416 seconds before commit. An explicit competing
write retry after release succeeded in 0.229 seconds. All six workloads passed
their state assertions. Retry exhaustion is the reproduced availability failure,
not a failed correctness assertion. The staged bulk is a controlled worst-case
attribution scenario, not the observed number of orphaned results on the instance.

The recorded-distribution controls distinguish traversal from mass mutation.
The fourfold sparse case still took 3.35 seconds for only 1,100 affected orders.
Increasing busy timeouts or merely reducing statement count does not establish
a bounded writer transaction.

Commit timing includes checkpoint work. SQLite can release the writer before a
passive checkpoint completes. Early raw files call an upper-bound transaction
window `writerLockHeldMs`; prefer `rollbackWithCommitMs` and the separate writer's
completion latency. These measurements do not prove exact exclusive-lock time.

Assertions checked signed declarations/order identity preservation, orphaned
quantities/status/capacity/revision reset, pre-fork controls, terminal attribution
after proof cleanup, successive rollback, rejection of old validation claims,
and independent source cancellation before and after contention. The disposable
TypeScript harness passed its own typecheck.

## Deferred Designs

### Coarse Chain Reset With a Durable Gate

This is the simpler candidate when temporary order-book unavailability and
discarding derived state are acceptable:

1. Atomically close a durable chain-level order-availability gate with the
   rollback/revision change. Every order-dependent quote/trading/read path must
   respect it; mutation paths must fence in-flight work and coordinate admission.
2. While closed, use small writer transactions to clear derived protocol state,
   obsolete coverage/leases and chain-derived terminal blockers across the chain.
   Keep signed declarations and independent source cancellations; no historical
   protocol result needs to be preserved selectively.
3. Durably enqueue validation for retained eligible orders through the existing
   demand owner, with current fork requirements. Once the reset and required
   demand are durable, reopen the book: unvalidated orders stay unusable and
   individual usable results return as validation completes. Do not wait for all
   RPC validations before reopening.
4. Persist progress and gate ownership so crashes restart closed and another
   reorg supersedes stale reset work safely. Define how observations arriving
   during reset are retained/replayed, especially explicit source cancellations.

This avoids per-result fork-range history and selective preservation, but the
read/write gate is still a correctness contract across processes and caches.
It is not an in-memory pause flag. Keeping current signed declarations avoids
depending on marketplace rediscovery. Deleting the entire book instead would
lose offchain offers absent from chain replay and require an explicit discovery
policy; simply replaying chain blocks cannot restore them.

### Whole-Chain Result Generation

Advance a per-chain result generation atomically and accept only results and
chain-derived retirement markers from the current generation. Reset/revalidate
old rows in the background. This can reopen progressively without a reset-wide
outage, but every result/read/cache consumer must enforce the generation and the
schema must distinguish it from independent source evidence. It deliberately
invalidates canonical pre-fork results too, increasing validation work.

### Selective Fork-Range Fences

Store each rollback revision and boundary. Persist result revision plus block,
including on chain-derived terminal retirement markers. A result is unusable if
any later fence covers its block. Apply that rule to every read/admission/cache
consumer before moving row rewrites into bounded durable repair batches. Existing
stale-commit guards remain necessary.

Successive reorgs require retaining earlier fences until safely compacted;
latest-only fencing could revive previously orphaned results. Read-only scanning
should happen outside the writer, with revision checks and atomic progress per
bounded write batch. Bounded matching-result pages alone do not bound scan time.
This preserves more availability and pre-fork work at greater contract complexity.

None of these designs makes unrelated transfer/ownership rollback work bounded.
RPC latency and affected-token memory remain separately unqualified under
`BKL-037`. Design choice requires explicit implementation authorization.

## Follow-Up Acceptance and Evidence

Before changing transaction boundaries, cover stale reads during repair,
in-flight validation/ingestion, source cancellation, orphan terminal markers,
pending request rebinding, cache invalidation, crashes/restarts, and successive
forks. All shared contract vocabulary belongs in its owning module and must be
used by consumers and tests. Reuse existing order demand/executor ownership;
do not add a REST lifecycle recovery path or legacy-data compatibility work.

Rerun the same six workloads with the competing writer, correctness controls,
and source preservation checks. Include admission while repair progresses and
report per-batch scan/mutation cost. Local passing results are not native,
remote-CI, live-provider, cold-start, power-loss, or many-writer qualification.

Local raw evidence remains under the active worktree's ignored directory:
`tmp/rollback-scale-f79grg2w/`. It contains `report.md`, `README.md`, `results.json`,
`runner.ts`, `tsconfig.json`, `snapshot.py`, `export-recorded.py`, `summarize.py`,
per-case results/logs, private databases, query plans, environment information,
and source/Git preservation records. Do not commit copied application databases
or remove these artifacts automatically. Raw evidence does not travel with a
merge; this document retains the portable findings and design constraints.

For reproduction, use that directory's README and existing project dependencies.
Create a new evidence directory under the worktree's `tmp/`; snapshot a stopped
instance with `snapshot.py --source <instance-main-directory> --output <new-directory>`.
Run `runner.ts` through `yarn node --import tsx`, with both `TMPDIR` and
`SQLITE_TMPDIR` pointing into the evidence directory. The sequence is `prepare`,
`observed <unique-label>`, `staged <unique-label>`, `deeper <unique-label>`,
`grow 4`, `staged <unique-label>`, then `export-recorded.py` and
`recorded <unique-label>`. Keep failed setup logs separate from passing workloads.
