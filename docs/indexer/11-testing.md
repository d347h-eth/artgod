# Testing (Indexer)

This document describes the current indexer test layout and the environment assumptions behind it.

Primary files:

- `indexer/tests/*`
- `indexer/tests/helpers/test-env.ts`
- `indexer/tests/helpers/test-helpers.ts`
- `indexer/tests/helpers/fixture-paths.ts`
- `indexer/vitest.config.ts`

## Current Test Layout

The normal runner uses `indexer/vitest.config.ts` and includes
`tests/**/*.test.ts`. Database suites create independent disposable files through
the maintained helpers; each test worker owns its SQLite singleton. The obsolete
workspace configuration with retired executor lists has been removed. This cleanup
does not change the active runner's isolation or parallelism.

Private broker fixtures have explicit configurations and commands for order queues,
reorg/restart behavior and OpenSea reconciliation. They use maintained child-worker
bundles and existing provisioned tools, never a live application store. The smoke
test has its own external/container prerequisites described below.

## Running Tests

From the repo root:

```sh
yarn test
```

This delegates to workspace-specific runners, so the frontend and indexer each run under their own Vitest config. The full command expects the smoke-test environment below and an available container runtime; it fails fast when either is missing.

From `indexer/` specifically:

```sh
yarn workspace @artgod/indexer test
```

For the complete indexer suite except the externally configured smoke test,
verify that `ARTGOD_DB_PATH` in `.env.test` resolves under the active worktree's
`tmp/`. `loadTestEnv()` overwrites process environment values from that file;
setting a shell variable alone does not establish isolation. Then run:

```sh
mkdir -p tmp
indexer_test_dir="$(mktemp -d "$PWD/tmp/indexer-tests.XXXXXX")"
TMPDIR="$indexer_test_dir" SQLITE_TMPDIR="$indexer_test_dir" \
  ARTGOD_DB_PATH="$indexer_test_dir/indexer.sqlite" \
  yarn workspace @artgod/indexer test --exclude tests/smoke.test.ts
```

## Test Environment

Tests load `.env.test` via `loadTestEnv()`.

Values present in that file overwrite the corresponding process environment.
Check its database and service targets before running tests: assigning a shell
`ARTGOD_DB_PATH` alone does not override the file. Keep disposable database paths
under the active worktree's `tmp/`; the queue fixtures use separate stores and
private loopback ports rather than app-data state.

Required keys for smoke/integration paths:

- `ARTGOD_DB_PATH`
- `SMOKE_NATS_PORT`
- `SMOKE_RPC_URL_LIST`
- `SMOKE_TARGET_COLLECTIONS`
- `SMOKE_RANGE_FROM`
- `SMOKE_RANGE_TO`
- `WETH_ADDRESS`
- `SEAPORT_CONDUIT_CONTROLLER`

Tests fail fast on missing config. There are no silent skips for missing required env.

## Fixture Path Rule

Fixture reads use file-relative paths through `tests/helpers/fixture-paths.ts`, not `process.cwd()`.

Reason:

- tests must work whether they are invoked from `indexer/` or from repo root via workspace commands
- file-relative resolution avoids brittle root-dependent fixture paths

## Smoke Test

The smoke test exercises the minimal end-to-end happy path:

1. load `.env.test`
2. set DB path and run migrations
3. start a NATS JetStream container through `testcontainers`
4. spawn `dev:sync-worker` and `dev:domain-worker`
5. publish a backfill job
6. wait for rows in `blocks`, `nft_transfer_events`, and `activities`
7. shut everything down

Files:

- `indexer/tests/smoke.test.ts`
- `indexer/tests/helpers/test-helpers.ts`

Important environment assumption:

- `smoke.test.ts` requires Docker or another supported container runtime
- if Docker is unavailable, this test fails explicitly

## Perpetual Gap Repair Coverage

The deterministic gap tests use disposable migrated SQLite databases and
deterministic RPC/broker test doubles. They do not use a live chain, broker, or application database.

- `tests/sync-gap-scheduler.test.ts` covers collection-specific internal holes,
  inclusive anchor bounds, all small coverage shapes, bounded backward scans,
  restart persistence, advancing and stationary heads, newly live collections,
  paused/disabled/unanchored collections, fair paging, reorg deletions, retained
  intent, repeated repair and stale identities. Scanning creates no publication.
- `tests/sync-gap-head-recheck.test.ts` covers the exact 30-minute boundary,
  downtime and restart, startup checks before the saved timer is due, fair
  bounded startup pages, preserving old progress when no newer hole exists,
  replacing it when one does, regressed heads, retained older holes, failed
  checks, bounded membership, complete skipped/failed pages, traversal wrap and
  restart, HEAD catch-up, stale cross-process saves, all small coverage shapes and
  a consistent WAL read snapshot with a competing connection.
  Incremental checks cover all newly eligible blocks, preserve broader timing
  and covered retry state, skip unchanged bounds, retry failed conditional saves
  and reset after rollback without starving later collection pages.
- `tests/rpc-budget-metrics.test.ts` verifies real Prometheus exports of active
  ceilings/modes, class-specific transport pressure/age and expired-state removal.
- `tests/rpc-budget-transport-monitor.test.ts` verifies separate broker/owner
  latency exports, deadline/error outcomes, bounded unresolved PINGs, shutdown
  without late reports and best-effort telemetry.
- `tests/automatic-sync-observability.test.ts` verifies shared-range progress,
  commit failure producing no success metrics, and best-effort telemetry after commit.
- `tests/sync-gap-query-cost.test.ts` seeds 50,000 pending collections and 400,000
  coverage blocks. It checks the global newest selection, SQL limits and ordered
  query plans after `ANALYZE`, including idle HEAD-check probes and direct seeks
  to later HEAD-check pages. It records warm local timings in
  `tmp/recent-gap-query-cost.json`; these are not a cold disk or fully covered
  26-million-block qualification.
- `tests/scheduler-worker.test.ts` verifies watermark capture before fresh head
  reads, stationary-head sampling, hints arriving during a read, revision-fenced
  retention, WS-only wakeups, overlapping poll prevention and shutdown draining.
- `tests/sync-gap-batching.test.ts` uses the real range pipeline and migrated
  SQLite adapters to verify shared headers/logs/receipts, separate coverage without
  current ownership effects, scoped activity follow-ups, common-suffix partial progress, restart, independent
  publication retry, stale members and RPC failure. The broker suite executes
  shared intent directly and delivers its scoped follow-ups through JetStream.
  A busy-peer comparison verifies that unequal gaps avoid its nine already
  covered transactions/receipts; 3,000 small planner configurations check exact
  per-member block accounting, no widening, bounds and eventual completion.
- `tests/sync-job-contract.test.ts` checks the current source/range/envelope
  contract and rejects automatic repair/recovery members on manual or bootstrap
  requests. The backfill-handler and broker tests preserve manual historical
  acquisition and ACK bootstrap wakeups without RPC. Automatic gap/reorg work
  uses retained coordinator state, not backfill queue envelopes.
- `tests/ownership-balances.test.ts` covers out-of-order ERC721 blocks/logs,
  burns, ERC1155 delta convergence, duplicate processing, anchor guards, and
  collection coverage rollback.
- `tests/reorg-rollback.test.ts` covers verified fork ownership with incomplete
  history and empty resync, persistent absent-token checkpoints, stale sync
  writes, changing rollback token scope, RPC and transactional failure, paged
  ERC1155 reversal and bootstrap checkpoint replacement.
- `tests/reorg-recovery.test.ts` exercises actual recovery use cases, fork search,
  exact-block snapshot adapter, SQLite and shared range/follow-up processing.
  It covers connected accepted ancestry independent of historical gap work at
  stationary HEAD, reopen/startup continuation, failed initial retention and
  atomic rollback/resync retention, partial publication without reacquisition,
  retry beyond ordinary publication limits, stale proof,
  newer mismatch, concurrent token scope and pre-rollback realtime results. A
  mixed-fork fixture proves that a later matching header cannot hide
  an earlier orphan; changed accepted lineage invalidates ancestor proof.
  Initial journal failures followed by RPC, wrong-height, checkpoint or header
  read failures cannot consume the pending DB check.
- `tests/reorg-restored-agreement.test.ts` covers transient disagreement at the
  accepted base, restart, coalesced later mismatches, stale generations and
  revisions, newer installed bases and interrupted resync. Genuine base
  replacement remains gated.
- `tests/reorg-filled-order-validation.test.ts` follows decoded transfer/fill
  receipts through terminal full validation, maintenance, coordinator rollback,
  replacement acquisition and full validation to a usable order again. It uses
  synthetic RPC data with production owners and a stipulated installed base.
- `tests/pending-canonical-checks.test.ts` covers atomic recent-block retention,
  unchanged maturity thresholds, duplicate imports, fresh-hash/revision fences,
  downtime beyond the realtime tail, durable retries and atomic recovery handoff.
  It also verifies prompt draining and shutdown of the serial check loop.
- `tests/rollback-snapshot-provider.test.ts` uses the real weighted RPC adapter
  against independently coherent disagreeing providers. Owners and recognized
  absence must come from the exact canonical hash; unsupported/unavailable/
  noncanonical selectors and unknown reverts cannot become absence or mutate
  facts, checkpoints or revision.
- `tests/reorg-recovery-migrations.test.ts` runs main-first and feature-first
  upgrade orders, preserving existing balances and unfinished recovery across
  reopen. It checks distinct same-prefix migration ledger entries, foreign keys
  and the actual collection purge adapter. A merged-schema upgrade retains old
  ranges/cursors, removes delivery state and only obsolete automatic publications.
- `tests/automatic-sync-executor.test.ts`, `tests/sqlite-sync-coordination.test.ts`
  and `tests/backfill-sync-handler.test.ts` use real migrated adapters to verify
  ascending shared/scoped prefixes, gap-disabled foreground catch-up, source
  barriers waiting for both prefixes, fair failed-scope retries, installed joining
  bases, restart, candidate rejection, atomic outbox/progress rollback and
  independent historical imports. Wakeups never acquire out of order.
- `tests/chain-sync-progress.test.ts`, `tests/coordinated-chain-progress.test.ts` and
  `tests/chain-history-retention.test.ts` cover exact predecessor/hash contracts,
  empty-block continuity, source sampling and dispute gates, bounded connected
  recovery windows, installed-base protection and bounded sample cleanup with
  pending/claimed admission mappings retained.
- `tests/bootstrap-ownership-installation.test.ts` proves atomic installed-base
  handoff, run/lease/anchor/revision fences, stale task completion rejection and
  duplicate installation preserving applied ownership. Bootstrap backfill/live
  tests require accepted progress instead of raw coverage and recheck it before
  final collection liveness.
- `tests/sync-follow-ups.test.ts` covers atomic data/outbox failure, ephemeral
  hints across reopen, required retry beyond ordinary limits, lost publication
  replies without RPC, stable IDs, accepted-row cleanup, orphan publication
  deletion and consumer admission, and unchanged bounded receipt behavior.
- `tests/metadata-refresh-range.test.ts` uses the production application handler
  and SQLite adapters to cover fixed root/origin/scope through several cursors,
  duplicate publication identity, orphan admission, ordinary/legacy envelopes,
  invalid scope/cursor rejection and large token IDs.
- `tests/sync-result-canonical.test.ts` verifies atomic rejection of orphaned
  facts and hints across every sync output group, mismatched receipts, missing
  headers, conflicting stored/duplicate headers and mixed parent chains. It also
  verifies canonical replacement after rollback and idempotent historical repair.
- `tests/sync-blocks.test.ts` covers fresh header reads, tip rechecking, changing
  ranges and complete bounded ancestor proof. Sparse or disconnected local
  history cannot be promoted to an accepted lineage or supply a guessed fork.
- `tests/automatic-sync-executor.test.ts` preserves serialization of current-state
  ranges and parallel execution of facts-only ranges.
- `tests/continuous-gap-loop.test.ts` verifies immediate bounded continuation,
  idle/error backoff, nonoverlapping passes and graceful stop without idle delay.
- `tests/rpc-work-allocation.test.ts` verifies durable work classes, async scope
  isolation, deferred snapshot/final verification attribution, current-validation
  main admission, main priority between backfill ranges and separate queue capacity.
  Maker SQLite tests cover retained continuation/publication class and quota
  deferral without failure count.
- `tests/historical-order-validation.test.ts` covers saved full-validation reuse
  across ordinary, maker and token paths, distinct event/observation requirements,
  rollback fencing and background hint admission followed by main validation.
  The real allocation scheduler and validation implementation complete strict
  snapshots with two competing streams at default and low background rates,
  and with disabled or unlimited gap policies.
- `shared/evm/rpc-budget.test.ts` verifies all six overall/gap mode combinations,
  shared per-endpoint rates, main use of idle allowance, bounded background
  concurrency, unlimited-gap main priority, cancellation, expiry, disabled
  work and endpoint identity privacy. Default 1.5 RPS/three-in-flight probes
  cover 500 ms and 1.5 s responses. RPC execution tests verify per-attempt
  admission including retries and no provider penalty for local quota waiting.
- `tests/fill-execution-upgrades.test.ts` upgrades populated legacy history,
  removes every sale source, preserves unrelated tables, and verifies atomic
  rollback/retry and resumed market-data recovery without restoring old sales.
  Real captured bundle receipts pass through the normal backfill
  handler, SQLite writer, activity projector and chart reader before/after the
  anchor, including duplicate transfers and a missing older ERC721 transfer.

Use the same isolated environment described above, selecting the affected files
with `yarn workspace @artgod/indexer test`. This establishes local storage and
scheduling behavior; it does not establish live RPC completeness or actual
broker delivery under outage conditions.

## Real-Broker Reorg Recovery Gate

`test:reorg:recovery` is an explicit integration runner using a provisioned NATS
binary and private loopback listeners. Use the isolated test environment above,
including required token/Seaport fixture values; inspect `.env.test` because it
overwrites shell values. From the active worktree root:

```sh
mkdir -p tmp
recovery_test_dir="$(mktemp -d "$PWD/tmp/reorg-tests.XXXXXX")"
TMPDIR="$recovery_test_dir" SQLITE_TMPDIR="$recovery_test_dir" \
  ARTGOD_DB_PATH="$recovery_test_dir/indexer.sqlite" \
  REORG_RECOVERY_TEST_NATS_BINARY="$PWD/src-tauri/resources/runtime/nats/nats-server" \
  yarn workspace @artgod/indexer test:reorg:recovery
```

Set `REORG_RECOVERY_TEST_NATS_BINARY` to an existing staged pinned binary if it is
provisioned outside this worktree. Missing inputs fail explicitly; the harness
does not download tools or use configured live services. The shared isolated-NATS
helper and child-worker bundler retain disposable SQLite/JetStream stores,
worker/broker logs and reports under `tmp/reorg-recovery-nats/`. Metadata range
broker fixtures retain their private stores and logs under `tmp/metadata-range-nats/`.
Bootstrap applied-progress/restart fixtures use `tmp/bootstrap-coverage-recovery-nats/`.
RPC allocation fixtures use `tmp/rpc-allocation-nats/`.

`integration/reorg-recovery.test.ts` exercises production recovery, worker,
outbox, SQLite and range/fanout implementations across:

- pending DB checks surviving repeated journal failures, including a later RPC
  outage after five failed writes and healthy eventual recovery;
- worker death after rollback, during RPC, after acquisition before publication,
  and during partial publication;
- broker restart over the retained private JetStream store;
- accepted publication with a lost reply and stable identity inside NATS's
  dedupe window;
- required publication beyond ordinary retry limits, without DLQ or reacquisition;
- durable recovery ownership through slow ownership reads without a check queue;
- a 401-token serial rollback snapshot with controlled per-read latency, recording
  completion time and process RSS while retaining one bounded resync obligation;
- ordered shared resync plus collection replay, independent of historical gap
  repair, including restart after a committed check handoff and lost obsolete
  automatic-hint ACK;
- a competing SQLite writer requiring bounded transaction retries, and stale
  proof from one process after another commits rollback.

`integration/metadata-range-refresh.test.ts` runs the production metadata range
handler, worker admission, sync outbox, metadata SQLite adapter and JetStream. It
verifies that a tail first delivered after rollback is ACKed without further URI
reads, and that a replacement root refreshes the full range after old root/tail
ACKs within the broker dedupe window. Token URI and HTTP responses are fixtures.

`integration/bootstrap-coverage-recovery.test.ts` uses this same runner and
isolated broker. It ACKs the bootstrap wakeup before any block RPC, then applies
one or two scoped prefixes through the real coordinator. It closes/reopens SQLite
and restarts JetStream with retained stores. A deliberately applied migration 067
clears fact coverage while preserving current-schema applied progress: raw
coverage cannot complete an unfinished prefix, and its absence cannot undo an
already applied prefix. The executor resumes only the missing suffix without
republishing acquisition jobs. Real ERC1155 decoding proves deltas apply once;
collection-live completion requires accepted shared/scoped progress. The fixture
does not assume an ACKed message's dedupe identity survives broker restart.

`integration/rpc-work-allocation.test.ts` uses independent budget clients on the
isolated broker. It covers shared rates/in-flight limits under main load, failed
request release, shutdown cancellation, missing-owner fallback for main only,
disabled background, unlimited gap concurrency across clients, a logical request surviving the 30-second transport deadline
at low rates, quota-independent broker/owner probes during a blocked background
permission, exported fallback/timeout counters and main queue delivery while a
background slot remains occupied.
It runs the production owner restart fence; no test override disables it.

RPC chain responses are deterministic fixtures. These checks establish the local
broker/database failure contracts; external-RPC smoke, native/package execution
and remote CI are separate qualification evidence.

## Offchain / OpenSea Coverage

Current focused coverage includes:

- embedded collection-extension resolution by contract + token scope (`tests/embedded-collection-extensions.test.ts`)
- OpenSea REST adapter shaping (`tests/opensea-api.test.ts`)
- OpenSea stream/REST normalization (`tests/opensea-normalize.test.ts`)
- offchain dispatch and token-set mismatch persistence (`tests/offchain-dispatch.test.ts`)
- canonical order raw-source precedence and Seaport data usage (`tests/orders-raw-source.test.ts`)
- Seaport validation (`tests/seaport-validate.test.ts`)
- partial and full-only orders on both sides, original/remaining/funded quantities,
  initial unknown remaining state, exact protocol fractions, receipt-free source
  sales, source-specific withdrawals, canonical cancellations, newer observations,
  rollback/revalidation and retained unexpired terminals
  (`tests/partial-fill-order-lifecycle.test.ts`)
- ordinary and bulk signature recovery, positional proofs, compact/standard
  encodings, malformed inputs and domain binding
  (`tests/seaport-protocol.test.ts`)
- captured bulk listing through scalar/pinned validation and disposable SQLite
  recovery, including REST signature preservation, current-ask visibility, RPC
  failure and concurrent source cancellation
  (`tests/seaport-bulk-validation.test.ts`)
- indexed maker/token/collection candidate scopes, including incomplete
  declarations and pre-anchor exclusion (`tests/maker-scope-selection.test.ts`)

The bulk-signature fixtures include a public listing captured on 2026-09-26 and
independent Seaport SDK vectors for heights 1 and 3. The height-24 vector uses a
sparse tree and the
[Seaport 1.6 type-hash constant](https://github.com/ProjectOpenSea/seaport-types/blob/fa8b592f991b30ddf10a3b71737c9c1d5e315d10/src/lib/ConsiderationConstants.sol).
Chain responses are synthetic; these tests establish cryptographic compatibility
and local projection/recovery behavior, not live marketplace availability or
onchain fillability.

These tests pin SDK response-shape normalization and adapter behavior. The REST
boundary accepts the SDK's camelCase fields such as `orderHash` and
`protocolData` while the raw/stream boundary retains snake_case fields such as
`order_hash` and `protocol_data`; criteria normalization likewise accepts both
forms at the adapter boundary. The tests do not prove live OpenSea pagination,
production rate-limit behavior, endpoint ordering, or stream delivery. A
release that changes the OpenSea dependency or adapter contract still needs a
credentialed live integration check; those observations must not be promoted
into ordering guarantees without an upstream contract.

## Heavy-maker Order Workload

`tests/orders-heavy-maker.test.ts` seeds a migrated disposable database with
9,339 synthetic WETH bids across two collections, a small maker, and a sold
token. It exercises the real candidate queries, validator and result writes
with deterministic fake RPC replies. The fixture generates one order at a time;
it does not copy a production orderbook or access an RPC endpoint.

```sh
TMPDIR="$PWD/tmp" SQLITE_TMPDIR="$PWD/tmp" \
  yarn workspace @artgod/indexer test tests/orders-heavy-maker.test.ts
```

The workload expands bounded durable maker scopes into ordinary per-order demand,
then validates every order through the sole ordinary executor. Small-maker and
token work make progress while the heavy scope drains. Exact-hash snapshots reuse
compatible wallet reads. Measurements use deterministic fake latency and are
local scheduling evidence, not a live recovery ETA.

`tests/maker-demand-expansion.test.ts` verifies finite scope expansion without
RPC. `tests/maker-validation-handoff.test.ts` expands 205 requirements before
validation, isolates a persistent order failure across restart/recovery, waits
for source barriers and preserves newer generations. Expansion cursor movement
and per-order demand retention share one writer; expansion completion is not
validation completion.

`tests/order-validation-demand-batch.test.ts` and
`tests/order-validation-demand-scheduler.test.ts` cover bounded exact-checkpoint
batches, shared snapshots, continuous draining, lease/revision/generation fences,
per-order failure isolation, quotas and shutdown. Waiting-for-sync work consumes
no validation permit. `tests/maker-revalidation-checkpoint.test.ts` covers scope
checkpoint/restart and receipt cleanup separately from ordinary proof commits.
`tests/historical-order-validation.test.ts` checks proof reuse and scope-to-ordinary
convergence without giving historical hints permission to choose a newer head.
`tests/future-order-validation.test.ts` verifies retained future-start work across
restart and replay, shared/collection checkpoint timing, ready-work fairness and
exclusive expiry. Full validation uses the accepted block timestamp even when
local wall time differs.

`tests/seaport-validation-batch.test.ts`, `tests/seaport-status-batch.test.ts` and
`tests/rpc-provider-resilience.test.ts` cover compatible snapshot sharing,
exact-hash contract/native-balance calls, bounded status aggregates, per-item
fallback and endpoint retry without a height-only fallback. Canonicality reads
bypass the general block cache. They use stubbed RPC, not external providers.

Run the maintained queue fixture with an existing staged NATS binary:

```sh
TMPDIR="$PWD/tmp" SQLITE_TMPDIR="$PWD/tmp" \
  ORDER_QUEUE_TEST_NATS_BINARY="$PWD/src-tauri/resources/runtime/nats/nats-server" \
  yarn workspace @artgod/indexer test:orders:queues
```

This command bundles a maintained child worker using the existing esbuild
dependency, starts the pinned NATS version on private loopback, and retains
synthetic stores/logs under worktree `tmp/`. It downloads nothing and never opens
app-data storage. `integration/order-queue-healing.test.ts` covers the 9,339-order
scope with small-maker/token fairness, two validation permits, source withdrawal
while ordinary validation reads are blocked, persistent per-order failure, and worker/broker
restart over retained stores. Maker completion records demand expansion; ordinary
proof completion is asserted separately. Lease recovery uses an injected clock
instead of waiting two real minutes.

`integration/order-source-admission.test.ts` configures one unacknowledged queue
slot and proves that durable source admission ACKs without receipt RPC. Unrelated
ready demand completes while the source requirement waits for its applied
checkpoint. Restart preserves the admitted requirement and resumes it only after
shared and collection progress cover its later sample.

`integration/order-backlog.test.ts` drains 10,002 supported current-format
source revalidation/lifecycle envelopes plus 1,000 arriving hints. It stops/resumes the
child, bounds demand identities without per-envelope outbox rows, and checks
committed domain state. Malformed bytes and an unsupported future envelope remain
stored through broker restart. Results and bounded samples stay under
`tmp/order-backlog-nats/`. This fixture does not establish pre-upgrade message
compatibility, provider throughput or native/package behavior.

`tests/order-processing.test.ts` covers FIFO admission, error release and the
lifecycle boundary. Backend `integration/order-lifecycle.test.ts` uses real
migrations, domain transitions, read models and HTTP adapters. Run it with
`yarn workspace @artgod/backend test integration/order-lifecycle.test.ts`.
`yarn workspace @artgod/frontend test:listings:history` runs the maintained
rendered fixture for sold-token asks and retained daily history; it remains
separate from native/live queue qualification.

`tests/source-order-delivery.test.ts` injects demand/terminal transaction failures
and failed ACKs, checks retained retries beyond the normal ceiling, and verifies
explicit no-RPC admission. `tests/order-processing-inspection.test.ts` verifies
the read-only progress tool's explicit inputs, bounded samples and unchanged
SQLite data version. Full counts require the operator's `--counts` opt-in.

## Ordinary Order Validation Demand

`tests/order-validation-demand.test.ts` uses migrated SQLite and strict full-order
snapshots. It covers 2,000 old hints coalescing to one validation, bounded receipt
storage, newer trigger generations/canonical revisions during RPC, cancellation
precedence, expiry/anchor checks, own-result revision handling, dead leases,
atomic upsert rollback and restart without a publication. The candidate query
plan uses the chain/due index without a temporary sort. Native-balance snapshot
pinning and failure propagation have validator and RPC-adapter coverage. The
existing failed-publish/unchanged-upsert tests still enforce no redundant writes.

Conduit-storage fault injection must leave order status unchanged, record no
coverage and retain retryable demand. In
`tests/order-validation-demand-batch.test.ts`, one persistently failing order in
a 100-order page is isolated after repeated failure: the other 99 finish, and
the remaining demand completes when its read recovers. Keep these ownership and
failure-isolation cases alongside the maker handoff tests when changing batching.

## Order Processing Observability

`tests/domain-processing-observability.test.ts` uses the shared Prometheus
serializer to verify duration units/buckets, bounded labels, overlapping active
work, FIFO cancellation/drain and metric-failure neutrality. A recording `ApmPort`
checks callback nesting and preservation of original errors without collectors.

The demand-batch, maker-handoff, maker-checkpoint, order-processing and queue-outbox
suites additionally verify telemetry against real disposable SQLite outcomes:
rolled-back results are not reported as committed coverage, a failed isolated
validation is visible under a successful durable handoff, and recovery/publication
outcomes reflect persisted state. Preserve these checks when changing retry catches
or checkpoint boundaries. The telemetry contracts and query examples are in
[Order processing metrics and APM](10-observability-and-metrics.md#order-processing-metrics-and-apm).

```sh
TMPDIR="$PWD/tmp" SQLITE_TMPDIR="$PWD/tmp" \
  yarn workspace @artgod/indexer test tests/domain-processing-observability.test.ts \
  tests/order-validation-demand-batch.test.ts tests/maker-validation-handoff.test.ts \
  tests/maker-revalidation-checkpoint.test.ts tests/order-processing.test.ts \
  tests/queue-outbox.test.ts
```

These checks verify instrumentation locally. Live scrape/trace ingestion and
rendered dashboards require separate runtime QA.

## OpenSea Reconciliation Regression

`tests/opensea-reconcile.test.ts` uses disposable migrated SQLite databases to
verify epoch comparisons, inclusive date boundaries, snapshot fallback, separate
startup/periodic thresholds, queue-delay admission, backlog suppression, failure
and retry, manual refresh, collection removal and complete listings-plus-offers
observations. `tests/worker-runner-lease.test.ts` covers long handlers, failure,
shutdown waiting and renewal-timer cleanup. Consumer-policy updates are covered
in `tests/nats-consumer-config.test.ts`.
`tests/order-source-reconciliation.test.ts` covers per-source withdrawal,
independent active sources, neutral hints, duplicate freshness during a crawl,
bounded page races and atomic seller-price refresh.

The maintained broker fixture is separate from the offline suite:

```sh
mkdir -p tmp
TMPDIR="$PWD/tmp" SQLITE_TMPDIR="$PWD/tmp" \
  OPENSEA_RECONCILE_TEST_NATS_BINARY="$PWD/src-tauri/resources/runtime/nats/nats-server" \
  yarn workspace @artgod/indexer test:opensea:reconciliation
```

Point `OPENSEA_RECONCILE_TEST_NATS_BINARY` at an existing project-staged NATS
binary. It must match the version in the runtime build policy. Missing inputs
fail explicitly; this command does not install or download tooling. It starts
only a loopback broker on an ephemeral port and keeps synthetic SQLite/NATS
stores and results under `tmp/opensea-reconcile-nats/` in the active worktree.

The real-broker test reproduces repeated handler execution without renewal,
then tests scaled lease renewal, updates to an existing durable, graceful
shutdown during active work, a 541-envelope backlog across eight collections,
and interrupted work recovered after a broker/consumer restart. It asserts
exactly eight useful scans and 533 acknowledged skips, with no extra run rows
or raw publications from skipped work. Test-only ACK durations are shorter;
production scheduling thresholds and concurrency are unchanged.

These fixtures do not prove live OpenSea pagination, native desktop behavior,
downstream projection convergence or a healthy live refresh cadence. Live QA
still needs a rebuilt app, preserved queued state, at least two scheduler ticks,
current asks/passive bids/listing-history inspection and a coordinated restart.

## Bootstrap Regression Cases

The [bootstrap contract](14-collection-bootstrap.md#manual-first-probe-form)
separates a short preflight, declared scope, and the anchored present subset.
Keep regression coverage at each boundary rather than relying on one live NFT
collection to exercise the entire flow.

| Case                     | Required behavior                                                                                                                                                                                                                                               | Maintained coverage                                                                         |
| ------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| Contract discovery       | Independent interface/name/supply/proxy checks; bounded 0/1 and enumeration candidates; one verified finalized observation; no sample-dependent recommendations.                                                                                                | Backend probe adapter, use-case and RPC suites                                              |
| Contract-call failures   | Real viem decoding of empty replies, reverts, unknown custom errors and missing selectors stops optional checks without retry delays or circuit penalties. Provider failures retry; empty ownership stays unknown and required reads retain zero-data failover. | Backend RPC, probe/family adapter and shared RPC policy/execution suites                    |
| Named contracts          | Milady, Remilio, Meridian, Grailers and AEON preserve explicit scope despite contract-wide findings and metadata failures. Synthetic assumptions are marked.                                                                                                    | `shared/testing/bootstrap-probe.ts`; backend, CLI and browser suites                        |
| Scope validation         | Canonical uint256 IDs, range bounds, count/list limits, deduplication, overlap and membership. No successful-probe prerequisite.                                                                                                                                | Shared token-ID/scope tests, API and frontend setup tests                                   |
| Art Blocks project scope | Registry-gated legacy/V3 lookup, exact project ID/range, distinct minted/maximum counts, pinned reads, unknown/error fallback, metadata independence, explicit apply and stale-result rejection.                                                                | Family adapter, inspection use-case/HTTP, frontend helper and bootstrap browser suites      |
| Sample selection         | Exact overrides never fall back. Automatic selection checks at most four declared candidates plus an optional discovery fallback; no arbitrary scan.                                                                                                            | `shared/bootstrap/sample-selection.test.ts`, backend inspection and browser suites          |
| Metadata and selectors   | Distinct ownership/URI/download/parse failures; configured retries for 429/server/transport failures; field edits re-evaluate retained JSON.                                                                                                                    | Probe adapter, shared metadata/selector/resilience tests, browser tests                     |
| Inspection isolation     | 10 MiB bounds; inert sandbox/CSP; escaped and masked long values; deep/wide DOM bounds; malformed JSON retained.                                                                                                                                                | Probe adapter/HTTP, `frontend/src/lib/json-preview.test.ts`, inspector browser cases        |
| Image measurements       | Real PNG/JPEG/WebP/SVG processing, resize/original dimensions, isolated failure/retry. Count edits reuse bytes; outside samples lose collection totals.                                                                                                         | `backend/src/http/handlers/bootstrap/estimate-bootstrap-image-cache.test.ts`, browser tests |
| OpenSea identity         | Exact NFT lookup, missing/mismatched/disabled/error recovery, no contract fallback. Outside samples are excluded without blocking manual queueing.                                                                                                              | Identity verifier, shared lookup, CLI, API and browser suites                               |
| Edits and late results   | Sample/media edits retain contract facts. Late contract/sample/image/OpenSea results cannot replace newer input. Acknowledgement gates all controls.                                                                                                            | `frontend/e2e/bootstrap-probe.spec.ts`, frontend helper tests                               |
| Manual admission         | Explicit range/list/entire-contract mode reaches the worker. Complete media fields need no probe. Requested unverified OpenSea attachment has explicit recovery.                                                                                                | CLI, backend API and browser suites                                                         |
| Sparse inventory         | Grailers-shaped 0–999 declared count stays 1000 while 704 synthetic present IDs are materialized. Unknown ownership and entirely absent scope fail.                                                                                                             | Indexer enumeration/ownership tests                                                         |
| Protocol boundaries      | Separate discovery/inspection, large IDs, stage failures, removed legacy fields, CSRF and admin/public guards.                                                                                                                                                  | `backend/src/api.test.ts`, sample-inspection HTTP tests                                     |
| Rendered journey         | Compact desktop grid and inspector, narrow stacking, single-line apply actions, inline progress and resolved badge.                                                                                                                                             | `yarn test:bootstrap:probe` plus rendered inspection                                        |
| Late OpenSea setup       | A positively owned local sample identifies the collection. Missing ownership and runtime capability have separate recovery states.                                                                                                                              | Late-sync use-case/API and collection browser scenarios                                     |

For real RPC, metadata and image requests, use the maintained read-only check:

```sh
yarn debug:bootstrap --backend-origin http://127.0.0.1:42710 --chain ethereum --address 0x5af0d9827e0c53e4799bb226655a1de152a425a5 --first-token-id 0 --token-count 10000 --sample-token-id 0 --output tmp/bootstrap-live-milady
```

This calls discovery, sample inspection and image estimation, saves the raw
responses, and writes the returned WebP preview plus timings to the output
directory. Repeat `--sample-token-id` to check several IDs. Failed metadata or
image checks produce a nonzero exit status. It never creates collections or
queues work. Only use trusted contracts, as with the form.

To test another gateway without changing the running app, replace
`--backend-origin` with `--rpc-url "$BOOTSTRAP_RPC_URL" --ipfs-gateway "$BOOTSTRAP_IPFS_GATEWAY"`.
Both values are required. This mode uses `app.inject()` with the production
HTTP handlers, use cases, RPC adapter, download policy and Sharp processor.
Only Ethereum chain routing is a fixture, checked against the real RPC chain
ID; it opens no database, queue or listener. This mode does not prove the
desktop launcher's environment or HTTP security middleware. Run
`yarn test:desktop:runtime-environment` against staged resources to cover the
packaged Node/Sharp launch boundary as well. Record external failures separately
from native import/processing failures; metadata and image CIDs can have
different availability at the same gateway.

Run `yarn test:bootstrap:probe` for desktop/mobile coverage. Artifacts are under
`tmp/bootstrap-revamp-playwright/`; see [UI testing](../ui/03-testing.md).
RPC and marketplace responses are deterministic fixtures. Image tests execute
the real native processor. These checks do not establish live OpenSea availability
or a real collection bootstrap.

Measure the pure decision modules independently:

```sh
yarn vitest run shared/bootstrap/scope.test.ts shared/bootstrap/sample-selection.test.ts shared/bootstrap/metadata.test.ts shared/collections/token-scope.test.ts shared/evm/token-id.test.ts frontend/src/lib/bootstrap-setup.test.ts frontend/src/lib/bootstrap-contract-probe.test.ts --coverage --coverage.include=shared/bootstrap/scope.ts --coverage.include=shared/bootstrap/sample-selection.ts --coverage.include=shared/bootstrap/metadata.ts --coverage.include=shared/bootstrap/probe.ts --coverage.include=shared/collections/token-scope.ts --coverage.include=shared/evm/token-id.ts --coverage.include=frontend/src/lib/bootstrap-setup.ts --coverage.include=frontend/src/lib/bootstrap-contract-probe.ts --coverage.reporter=json-summary --coverage.reporter=text --coverage.reportsDirectory=tmp/bootstrap-revamp-coverage
```

The measured module set is explicit. This coverage supplements HTTP, CLI,
anchored-worker and rendered interaction checks.

### User-Supplied Contract Fixtures

Expectations supplied on 2026-09-28; these are not fresh live observations:

| Collection   | Address                                      | Declared start/count | Enumerable                         | OpenSea slug                   |
| ------------ | -------------------------------------------- | -------------------- | ---------------------------------- | ------------------------------ |
| Milady       | `0x5af0d9827e0c53e4799bb226655a1de152a425a5` | 0 / 10000            | yes                                | `milady`                       |
| Remilio      | `0xd3d9ddd0cf0a5f0bfb8f7fceae075df687eaebab` | 1 / 10000            | no                                 | `remilio-babies`               |
| Meridian     | `0xa7d8d9ef8d8ce8992df33d8b8cf4aebabd5bd270` | 163000000 / 1000     | check independently                | `meridian-by-matt-deslauriers` |
| Grailers DAO | `0xd89239186180617cfe17e8b73b2b8bd9c96d0a15` | 0 / 1000             | check independently                | `grailers-dao`                 |
| AEON         | `0xc374a204334d4edd4c6a62f0867c752d65e9579c` | 1 / 3333             | earlier non-Enumerable observation | not supplied                   |

Meridian's project scope remains an explicit user choice. For supported,
registry-confirmed Art Blocks contracts, inspection suggests the sampled project's
exact start and separate minted/maximum counts. The generic probe does not infer
project ranges for arbitrary contracts.
The user estimated approximately 704 minted Grailers tokens; this is not a verified
live inventory. Its deterministic worker fixture selects exactly 704 IDs from
0–999, omits the first ten and includes additional holes. That set is synthetic.

### Shared-Contract Manual Fixture

Use **Memories of Qilin by Emily Xie** to distinguish real Enumerable support
from one project's scope:

- Ethereum contract: `0xa7d8d9ef8d8ce8992df33d8b8cf4aebabd5bd270`
- sample and first ID: `282000000`
- total supply: `1024`; inclusive range: `282000000..282001023`
- OpenSea slug: `memories-of-qilin-by-emily-xie`
- observed metadata fields: `image` and `generator_url`

The 2026-08-07 investigation confirmed working contract-wide enumeration:
`totalSupply()` returned `198051`, while `tokenByIndex(0)` returned
`4000000` (Dynamic Slices), not a Qilin token. Qilin IDs `282000000`,
`282000001`, and `282001023` appeared at global indexes `157219`,
`158408`, and `159430`, respectively. Their interleaving is why a working
Enumerable interface cannot identify a subcollection. Contract-only OpenSea
lookups also returned unrelated project slugs during the investigation.

Those are dated observations, not current RPC expectations. The regression
invariant is that an explicit Qilin sample stays exact and a manually selected
Qilin scope survives probing. It must not silently become whole-contract
enumeration. The fact that this fixture's sample equals its range start must
not become a general inference rule.

### Partially Minted Manual Fixture

Use Grailers DAO's user-supplied range 0–999 to keep declared boundaries
independent from minted samples. Bounded discovery may find no owner for 0/1
or the first four range candidates. Choose a known owned sample manually;
the deterministic fixture uses ID 10.

Historical investigations reported different counters and samples. Those
observations are not a current inventory, cap or authoritative boundary.
The regression preserves the entered range regardless of an absent lower
ID or a contract-wide count. Only the anchored worker materializes the present
subset; uncertain RPC failures remain errors.

### Manual Verification Boundary

Probe-only QA can exercise the form without queueing a real bootstrap:

1. Stage a fixture, choose Token range for its manual scope,
   and verify that edits make no probe requests.
2. Press **probe**, review/apply the metadata fields, and verify that the sample,
   first ID, and supply retain their distinct meanings.
3. Inspect the request parameters: OpenSea resolution uses only the sample,
   never range boundaries, collection inventory, or a contract-only fallback.
4. Correct an invalid sample or metadata field and retry explicitly; check
   recovery without losing the other inputs.
5. Verify that a complete manual definition remains eligible after an optional
   check fails, and that each missing/invalid required input is explained in its
   own section. Stop before queueing against a live store.

Only run a real installation against an explicitly authorized isolated local
runtime/database. Record the chosen anchor and confirm that only proven-present
IDs receive metadata tasks while the full declared scope remains stored. The
preview sample need not exist at the older anchor; the anchored set must instead
be nonempty. Provider/archive errors must not be silently counted as absent.
Check future mint routing separately from probe-only or mocked coverage, and
never turn this regression into a full contract-history backfill. Keep logs and
screenshots in a project-local task-artifact directory without secrets.

## Practical Notes

- The Vite `spawnSync /bin/sh EPERM` warning can appear in restricted sandboxes. It is unrelated to actual test results.
- DB-backed tests need teardown order to respect current foreign-key chains (`collection_trait_stats`, `token_sets`, `attributes`, etc.).
- Workspace-level orchestration matters: running a single unconfigured repo-level Vitest sweep can bypass workspace-specific config such as the frontend SvelteKit plugin.

## Current Limitations

- `smoke.test.ts` still reads `WETH_ADDRESS` from the loaded test environment
  when building child-process input rather than consuming the same typed config
  boundary as production composition.
- Database integration fixtures intentionally use real migrations and adapters;
  replacing them with in-memory doubles would hide their persistence contracts.

The partial-fill lifecycle regressions also cover terminal-demand cleanup followed
by rollback, successive forks, retirement attribution and source cancellation,
impossible cumulative fractions, causal source admission, retained pre-sale
proofs and lagging providers catching up without another source message. Source
receipt prerequisites and their obsolete test executor have been removed; pinned
checkpoint and dispute tests cover validation canonicality. Shared thin-price parser and snapshot projection tests
exclude exhausted/malformed remainders on both fallback paths.

## Sync and order simplification qualification

`tests/maker-revalidation-rollback.test.ts` exercises the real storage rollback
and positive-read guard. It covers immediate invalidation across revisions,
current/requested and intermediate coalesced requirements, promoted partial
passes, exact ancestor rebinding, repeated rollback, stale leases, source/receipt
identity, new-event coalescing and atomic failure. No separate recovery loop or
synthetic proof bypass is used.

The [mechanism reconciliation](19-order-processing-cleanup.md) maps the removed
paths and retained obligations. `canonical-maker-admission.test.ts` verifies no
run or queue work for irrelevant WETH owners, one coalesced continuation for a
relevant scope, persistence after reopen, and rollback of admission/progress when
wakeup retention fails. `canonical-order-effects.test.ts` retains scope/anchor,
chain attribution and direct by-ID effect coverage. `sync-follow-ups.test.ts`
uses actual metadata events for required-publication/reorg proofs after canonical
order publications are removed.

The reorg process fixture constructs `AutomaticSyncExecutor` and
`startAutomaticSyncLoop`, as production does. Focused check/rollback cases disable
forward work selection to inspect the durable handoff; full coordinator cases
exercise acquisition and restart. There is no alternate fixture recovery loop.
The coordinator suite verifies overlapping calls share one pass; the manual
backfill handler suite proves facts-only history can complete during a blocked
current-range RPC without acquiring a second current-state authority.

`source-order-delivery.test.ts` and `order-queue-contracts.test.ts` exercise the
actual lifecycle/upsert boundary with explicit source provenance and observation
time. Canonical messages cannot enter the source route. Private broker backlog
fixtures publish supported source observations; they no longer retain a dead
by-ID route or pacing executor just to run a benchmark.
