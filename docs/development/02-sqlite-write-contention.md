# SQLite Write Contention

This document owns ArtGod's cross-process SQLite write-contention policy and
the production write-path inventory. It records the repository-wide audit from
2026-08-20 and separates safe baseline handling from recovery behavior that
needs a domain decision. The regular-write inventory was rechecked against
current source on 2026-09-13.

Primary files:

- `shared/database/db.ts`
- `shared/database/migrations.ts`
- `backend/src/infra/**/sqlite-*.ts`
- `indexer/src/infra/**/sqlite*.ts`
- `trading/src/adapters/**/sqlite-*.ts`

## Concurrency Model

The desktop supervisor runs the backend, bidding bot, and multiple indexer
workers as separate Node processes over one local SQLite database. Every
process lazily opens one `better-sqlite3` connection. WAL mode permits readers
to overlap a writer, but SQLite still permits only one writer at a time.

The native `busy_timeout` waits inside one lock acquisition. It does not retry
an entire logical transaction. In particular, a default deferred transaction
can read a snapshot and then fail immediately with `SQLITE_BUSY_SNAPSHOT` when
it tries to become a writer. Queue redelivery or a process restart is too coarse
to be the primary response to this local contention.

## Baseline Policy

The shared database boundary applies one bounded policy:

- SQLite waits up to 5 seconds for each ordinary busy lock.
- ArtGod makes at most 3 attempts, with 10 ms and 20 ms backoffs between them.
- `SQLITE_BUSY` and its extended result codes, including
  `SQLITE_BUSY_SNAPSHOT`, are retryable.
- `SQLITE_LOCKED` is not retried. It describes a same-connection or shared-cache
  conflict that needs a code or transaction-boundary correction.
- A prepared autocommit write retries the complete single statement.
- `db.writeTransaction(...)` uses `BEGIN IMMEDIATE`, so write intent is acquired
  before callback reads, and retries the complete callback after rollback.
- A write-transaction callback must be synchronous and replay-safe. It may run
  up to 3 times, so it must not perform external effects or retain mutation
  from a failed attempt.
- A statement already inside a transaction is never retried independently.
  The outer transaction is the only safe retry unit.
- A nested `db.writeTransaction(...)` uses the existing transaction/savepoint
  behavior and leaves retry ownership with the outer transaction.
- Connection setup and statement preparation use the same busy classification.

`db.exec(...)` is not retried generically because it may contain multiple SQL
statements and could have partially executed. Production migration SQL runs
inside `db.writeTransaction(...)`; new multi-statement uses must do the same or
document a deliberate exception.

Retries are synchronous because `better-sqlite3` is synchronous and its native
busy wait already blocks the calling process. The additional JavaScript
backoff is deliberately small and bounded. In the worst case, 3 complete
5-second native waits plus backoff can block that process's event loop for about
15.03 seconds before the error escapes. This is the nominal contention wait for
one lock acquisition per attempt, not a deadline for executing SQL or an entire
business operation. The native timeout and retry budget are code-owned in
`shared/database/db.ts`; no manifest, environment, or Admin setting exposes them.

## Audit Summary

The audit covered production TypeScript under `shared`, `backend`, `indexer`,
and `trading`, plus every migration startup caller. Test-only database setup and
the SQL migration contents were excluded from the runtime-path count. The
frontend and Rust desktop shell do not open the application database directly.

| Area                    | Write-owning modules | Original default deferred transactions | Baseline result                                      |
| ----------------------- | -------------------: | -------------------------------------: | ---------------------------------------------------- |
| Backend                 |                    9 |                                     16 | 15 converted; collection purge held for review       |
| Indexer                 |                   19 |                                     23 | all converted                                        |
| Trading                 |                    4 |                                      3 | all converted                                        |
| Shared migration runner |                    1 |                                      0 | existing immediate unit moved to the shared boundary |
| Total                   |                   33 |                                     42 | 41 converted; 1 deliberate outlier                   |

All production autocommit writes prepared through `db.prepare(...).run()` now
receive the single-statement baseline. The only dynamic raw prepared write is the bootstrap-step
claim update, which runs inside a protected transaction. The collection purge
statements run inside the documented raw-transaction outlier below.

## Read-Before-Write Hazards

Sixteen original deferred transactions read before their first write. These
were the paths most exposed to an immediate snapshot-upgrade failure.

| Area                          | Count | Operations                                                                   |
| ----------------------------- | ----: | ---------------------------------------------------------------------------- |
| Backend bootstrap             |     1 | inspect failed metadata tasks before resetting task and step state           |
| Backend bidding price tiers   |     2 | read existing tier before upsert or archive                                  |
| Backend bidding jobs          |     6 | token/collection upsert, batch update, archive, and pricing update decisions |
| Indexer bootstrap             |     1 | select claim candidates before fenced step updates                           |
| Indexer activities            |     1 | inspect existing activity state before replay-safe upsert                    |
| Indexer storage               |     1 | read transfers before reorg rollback writes                                  |
| Indexer collection extensions |     3 | inspect synthetic-token state before publish, replace, or retire             |
| Trading commands              |     1 | select claimable commands before fenced claim updates                        |

`BEGIN IMMEDIATE` removes the read-snapshot promotion race from these paths.
The observed bidding-bot startup failure was the trading command-claim path in
the final row.

## Production Write Inventory

The inventory is grouped by the adapter that owns each persistence operation.
"Autocommit" means a single prepared statement at the adapter boundary; it does
not imply that a helper called from a listed transaction commits separately.

### Shared

| Owner                           | Write operations                                        | Handling                                                                                        |
| ------------------------------- | ------------------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| `shared/database/migrations.ts` | migration ledger creation, migration SQL, ledger insert | precheck without a writer lock; recheck and apply atomically through `db.writeTransaction(...)` |

Ten indexer runtimes and the backend invoke this runner during startup.
Concurrent startups therefore contend at this shared boundary before their
runtime loops begin. Trading does not run migrations; it opens the same database
and prepares its adapters, so concurrent schema startup can still block or fail
its connection/statement initialization.

### Backend

| Owner                                                             | Write operations                                                                                        | Handling                                                               |
| ----------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------- |
| `infra/bootstrap/sqlite-bootstrap-runs.ts`                        | collection preparation, run creation/abort, events, pause/resume, failed-task and terminal-step retries | 6 transaction units plus protected autocommit statements               |
| `infra/trading/sqlite-bidding-jobs-repository.ts`                 | token/collection job upsert and archive, batch pricing updates, cancellation requests, command enqueue  | 6 transaction units; constituent and remaining single writes protected |
| `infra/trading/sqlite-bidding-price-tiers-repository.ts`          | tier upsert/archive and resolution updates                                                              | 3 transaction units                                                    |
| `infra/collections/sqlite-collection-customization-records.ts`    | customization feature upsert                                                                            | protected autocommit                                                   |
| `infra/collections/sqlite-collection-settings-repository.ts`      | collection setting upsert                                                                               | protected autocommit                                                   |
| `infra/collections/sqlite-opensea-collection-sync-repository.ts`  | mark OpenSea pending and restore prior state                                                            | protected autocommit                                                   |
| `infra/collections/sqlite-opensea-stream-ingestion-repository.ts` | stream ingestion status update                                                                          | protected autocommit                                                   |
| `infra/media/sqlite-token-image-cache-maintenance.ts`             | collection image-cache row deletion                                                                     | protected autocommit                                                   |
| `infra/collections/sqlite-collection-purge-repository.ts`         | ordered collection-wide deletes and post-delete verification                                            | explicit deferred outlier; see below                                   |

Read-only backend repositories and shared read models are not write-contention
paths and are excluded from this table. In particular, the two bid-book read
transactions in `infra/trading/sqlite-bidding-bid-book-repository.ts` deliberately
retain deferred snapshot reads; they must not acquire a writer lock.

### Indexer

| Owner                                             | Write operations                                                                                      | Handling                                                         |
| ------------------------------------------------- | ----------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------- |
| `infra/bootstrap/sqlite-runs.ts`                  | run status/anchor updates and run events                                                              | protected autocommit                                             |
| `infra/bootstrap/sqlite-steps.ts`                 | claim, lease, progress, completion, failure, pause, and resume                                        | claim transaction converted; remaining statements protected      |
| `infra/bootstrap/sqlite.ts`                       | snapshot rows/finalization/cleanup; metadata, image, ownership, and extension-artifact task lifecycle | 8 transaction units plus protected task statements               |
| `infra/attributes/sqlite-token-attributes.ts`     | replace attribute links, keys, and values                                                             | called inside metadata or extension transactions                 |
| `infra/collection-extensions/sqlite.ts`           | extension install/artifact upsert; synthetic-token publish/replace/retire; attribute replacement      | 4 transaction units plus protected single writes                 |
| `infra/collections/sqlite.ts`                     | collection bootstrap and OpenSea identity/lifecycle/health state                                      | 15 protected single-statement operations                         |
| `infra/conduits/sqlite.ts`                        | conduit upsert and channel replacement                                                                | 1 transaction unit plus protected upsert                         |
| `infra/domain/activities.ts`                      | replay-safe activity and source projection                                                            | 1 transaction unit plus protected domain-sync statements         |
| `infra/domain/metadata.ts`                        | token identity, metadata, and attributes                                                              | 1 transaction unit; remote resolution completes before it begins |
| `infra/domain/metadata-stats.ts`                  | collection trait-stat rebuild                                                                         | 1 transaction unit                                               |
| `infra/domain/orders.ts`                          | maker/order state and observation-driven upserts                                                      | protected single statements and loops                            |
| `infra/media/sqlite-token-image-cache-records.ts` | conditional cache record upsert                                                                       | protected autocommit                                             |
| `infra/metadata/sqlite-refresh-followups.ts`      | refresh run/task state and transactional outbox enqueue                                               | 3 transaction units                                              |
| `infra/offchain/sqlite-observations.ts`           | order observation insert                                                                              | protected autocommit                                             |
| `infra/offchain/sqlite-order-source-state.ts`     | mark missing snapshot orders inactive                                                                 | protected autocommit                                             |
| `infra/offchain/sqlite-orderbook-runs.ts`         | orderbook run start/complete/fail                                                                     | protected autocommit                                             |
| `infra/queue/sqlite-queue-outbox.ts`              | enqueue, mark sent, and mark failed                                                                   | protected autocommit; post-publish ambiguity remains below       |
| `infra/storage/sqlite.ts`                         | canonical sync persistence and reorg rollback                                                         | 2 transaction units                                              |
| `infra/token-sets/sqlite.ts`                      | token-set upsert and member insertion                                                                 | member transaction converted; split atomicity remains below      |

The read-only bidder index, image-cache policy, and order-activity lookup
adapters are excluded.

### Trading

| Owner                                                     | Write operations                                                              | Handling                                                         |
| --------------------------------------------------------- | ----------------------------------------------------------------------------- | ---------------------------------------------------------------- |
| `adapters/jobs/sqlite-bidding-job-command-repository.ts`  | command claim, completion, retryable failure, and terminal failure            | claim transaction converted; terminal statements protected       |
| `adapters/jobs/sqlite-bidding-job-runtime-state.ts`       | job state, cancellation lifecycle, and active-order verification invalidation | protected autocommit                                             |
| `adapters/bid-book/sqlite-bidding-bid-book-projection.ts` | replace projected rows/state and record projection error                      | replacement transaction converted; error statement protected     |
| `adapters/runtime/sqlite-bidding-bot-runtime-state.ts`    | authorized collection replacement and heartbeat/runtime state                 | replacement transaction converted; heartbeat statement protected |

The job source and token-metadata adapters are read-only. The OpenSea policy
wallet has a method named `run`, but that method is a signing-session boundary,
not a database operation.

## Deliberate Outliers And Decisions

The baseline reduces ordinary lock failures. It does not decide what a domain
should do if all attempts fail, nor does it make a database update atomic with
NATS, filesystem, or marketplace effects.

### Collection purge transaction

`backend/src/infra/collections/sqlite-collection-purge-repository.ts` retains
one explicit raw write transaction. It deletes across collection-scoped tables
and dynamically verifies the schema. Its first statement already writes, so it
does not have the read-snapshot promotion race covered by the baseline. The
callback is database-only, but its duration and lifecycle consequences require
a separate design. Purge hardening is explicitly deferred under `BKL-065`, with
per-collection admission and verified shutdown under `BKL-064` in the
[unified backlog](../planning/01-unified-backlog.md). The
[collection lifecycle reference](../backend/01-api-and-application-architecture.md#collection-lifecycle-controls-and-purge)
records the current gaps and future design constraints; this baseline does not
implement purge coordination or replay.

### Uncaught lease and heartbeat timers

- `indexer/src/application/bootstrap-step-orchestrator.ts` renews a step lease
  from a synchronous interval callback without a catch.
- `indexer/src/application/collection-extensions/refresh-artifacts-lifecycle.ts`
  has the same behavior for extension-artifact leases.
- Trading heartbeat persistence can similarly escape its interval after the
  shared retry budget is exhausted.

The database calls now have baseline retries. The remaining decision is whether
exhaustion means lease loss, a stopped runtime, or a process-fatal invariant.

### External side effect followed by database bookkeeping

- The queue-outbox drainer publishes to NATS before marking the row sent. A
  successful publish followed by exhausted database contention can consume an
  outbox attempt and rely on message-ID deduplication.
- Trading command completion and offer/cancellation runtime-state writes can
  follow an OpenSea or wallet side effect. Blindly replaying the surrounding
  business action would be unsafe even though retrying the local statement is
  safe.
- Backend bootstrap start/customization/settings/OpenSea-sync flows span
  separate database units and NATS or filesystem work. The shared retry policy
  does not make those larger flows atomic.

These need explicit idempotency and reconciliation contracts, not a broader
generic retry loop.

### Failure classification and swallowed persistence

- Bootstrap, extension, and OpenSea broad catches can count exhausted local
  contention against business/task attempts and eventually terminalize work.
- Order persistence can repeat remote validation after an exhausted local
  write, spending business attempts on infrastructure contention.
- Collection-wide image-cache refresh catches a generated-file persistence
  failure per token and lets the page job continue; cleanup is also skipped on
  that path, so a file can be orphaned.

These cases need an infrastructure-versus-domain error policy and, for image
cache, a durable retry or cleanup decision.

### Retry observability

The shared boundary preserves the final native SQLite error but does not yet
emit a log or metric for attempts that recover. Decide whether aggregate busy
attempt/exhaustion metrics are needed before adding low-level logging to every
process.

### Split persistence and long transactions

- Token-set row upsert and member insertion remain separate persistence units.
  Replay and uniqueness repair most partial progress, but changing atomicity is
  a domain decision.
- Canonical sync persistence, reorg rollback, trait-stat rebuild, bootstrap
  snapshot/task batches, token-set member insertion, metadata follow-up
  batches, and attribute-heavy replacements can hold the single writer for a
  long time.

These transactions are safe to retry as complete units. Any future batching
must preserve their current atomicity invariants rather than shortening them
mechanically.

## Review Checklist For New Writes

For every new SQLite write:

1. Use `db.prepare(...).run()` for one atomic statement.
2. Use `db.writeTransaction(...)` for a multi-statement invariant or any
   read-before-write decision.
3. Keep external I/O, logging with business meaning, and caller-visible
   mutation outside a retryable transaction callback. Generate time/random
   values before it unless they remain attempt-local and cannot escape a
   rollback.
4. Do not catch and reclassify exhausted database contention as a known domain
   failure without an explicit policy.
5. Document any use of `db.raw.transaction(...)` or multi-statement
   `db.exec(...)` here with its retry and recovery decision.
6. Add a two-connection contention test when changing the shared boundary.
