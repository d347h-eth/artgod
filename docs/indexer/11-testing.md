# Testing (Indexer)

This document describes the current indexer test layout and the environment assumptions behind it.

Primary files:

- `indexer/tests/*`
- `indexer/tests/helpers/test-env.ts`
- `indexer/tests/helpers/test-helpers.ts`
- `indexer/tests/helpers/fixture-paths.ts`
- `indexer/vitest.config.ts`
- `indexer/vitest.workspace.ts`

## Current Test Layout

The indexer test suite is split into two Vitest projects.

### Unit project

Configured in `indexer/vitest.workspace.ts` as `name: "unit"`.

Characteristics:

- runs under normal parallelism
- includes pure/unit tests that do not mutate the shared SQLite singleton
- covers normalization, decoding, validation helpers, API adapters, and other isolated logic

### DB-backed project

Configured in `indexer/vitest.workspace.ts` as `name: "db"`.

Characteristics:

- includes suites that call `setDbPath()` and mutate the shared SQLite singleton
- runs serially (`fileParallelism: false`, `maxConcurrency: 1`)
- covers canonical order persistence, token sets, metadata stats, offchain dispatch, and smoke test wiring

Current DB-backed files include:

- `tests/metadata-stats.test.ts`
- `tests/token-sets.test.ts`
- `tests/smoke.test.ts`
- `tests/offchain-dispatch.test.ts`
- `tests/orders-raw-source.test.ts`
- `tests/orders-update-by-maker.test.ts`

This keeps only the shared-DB suites serialized instead of slowing down the entire test suite.

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

## Offchain / OpenSea Coverage

Current focused coverage includes:

- embedded collection-extension resolution by contract + token scope (`tests/embedded-collection-extensions.test.ts`)
- OpenSea REST adapter shaping (`tests/opensea-api.test.ts`)
- OpenSea stream/REST normalization (`tests/opensea-normalize.test.ts`)
- offchain dispatch and token-set mismatch persistence (`tests/offchain-dispatch.test.ts`)
- canonical order raw-source precedence and Seaport data usage (`tests/orders-raw-source.test.ts`)
- Seaport validation (`tests/seaport-validate.test.ts`)
- scoped maker-triggered order revalidation (`tests/orders-update-by-maker.test.ts`)

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

The baseline reports contract reads by purpose, virtual wire time (10 ms/read),
local validation time and remaining SQLite/orchestration time. It verifies that
the original serial handler finishes the entire maker before following token
work, and replays the first page after interruption. Compare later changes on
the same fixture and virtual latency; wall time is local synthetic evidence,
not a live recovery ETA. Queue depth and useful validation count are separate
measurements. No inspector extension is needed for this offline baseline.

`tests/order-validation-demand-batch.test.ts` exercises the individual-order demand
path with real disposable SQLite and a batch-capable fake RPC. A 250-order case
uses three snapshots, 13 status aggregates and nine shared wallet reads; all 250
receive guarded completion. Mixed makers/sells, future triggers, obsolete pages,
time-budget release, concurrent claims, lost leases, source/revision/generation
changes, reorgs, failed SQL commits and graceful stop verify durability. A repeated
order-specific read failure isolates retries so the other 99 orders can finish
before that fault is repaired. These
call counts and virtual latency are synthetic evidence, not live throughput.

Its sustained-admission case drives the production demand scheduler against
disposable SQLite with 10 ms simulated latency per RPC port call, including
block/head checks. It drains an initial 1,000 orders while accepting another 30
per simulated second for ten seconds. All 1,300 are covered by the 11-second
cutoff, with two RPC calls active at most; lifecycle work and a waiting competing
validation request both proceed. This controlled workload does not qualify a
live provider or predict native catch-up time.

`tests/order-validation-demand-scheduler.test.ts` covers continuous draining,
idle/error backoff, FIFO sharing with maker/token work, and shutdown while queued
or active. Reporting tests distinguish checks from durable effects and verify
bounded window aggregation; inspector tests distinguish scheduler samples from
opt-in global age/lease/retry aggregates.

The same migrated workload also exercises bounded WETH snapshots: with 100
orders per context, 94 contexts perform 9,339 order-status reads and 282 shared
wallet reads. `tests/seaport-validation-batch.test.ts` covers scope isolation,
in-flight sharing, early/terminal decisions, changing balances, count/time
bounds, RPC and conduit-registry failures, stale heads and branch changes. Database interleavings
verify that failed contexts leave prior state intact and newer source/anchor
changes win. The RPC adapter test checks that canonicality reads bypass its
general block cache. These are deterministic local proofs, not native QA.

`tests/seaport-status-batch.test.ts` covers bounded lazy status aggregates,
per-item failure and malformed-result fallback, provider rejection/cooldown,
block/protocol isolation and reorg rejection. The RPC adapter test exercises
real Viem encoding/decoding against stubbed HTTP responses, including endpoint
retry after a failed aggregate. It does not contact an external provider.
The checkpoint suite runs all 9,339 bids through actual durable steps with the
batch-capable fake: 467 status aggregates plus 282 shared wallet calls = 749
contract RPC calls, versus 9,621 after wallet sharing alone. Logical reads remain
9,621; virtual wire time becomes 7,490 ms at 10 ms per aggregate/single call.
These counts exclude block lookups, provider retries and cold conduits. The fake
does not measure deployless execution gas, billing or live endpoint support.

```sh
TMPDIR="$PWD/tmp" SQLITE_TMPDIR="$PWD/tmp" \
  yarn workspace @artgod/indexer test tests/seaport-status-batch.test.ts \
  tests/maker-revalidation-checkpoint.test.ts tests/rpc-provider-resilience.test.ts
```

`tests/maker-revalidation-checkpoint.test.ts` reopens migrated SQLite after an
interruption, exercises the actual atomic result/cursor transaction (including
SQLite busy retry), and checks lease fencing, changed/deleted orders, finite
admission, completion before ACK and ACK-boundary receipt cleanup. The worker
test checks delivery-origin mapping and deferred lease waits. Broker-origin
and restart integration is a separate real-NATS gate; these SQLite tests do
not establish broker or native runtime behavior. They also exercise elapsed
budgets, duplicate continuations, terminal outbox failures, missing wakeups,
recovery races and bounded rotating recovery pages. Maker coalescing cases cover
2,000 old hints sharing a pass, live-scope coverage after ACK, distinct chain/
selection/anchor modes, demand arriving before the first checkpoint, and restart
at a full follow-up pass boundary with no missed earlier orders.

`tests/maker-validation-handoff.test.ts` injects a persistent order read failure
among 250 orders: 249 finish while one remains in isolated demand, then completes
after its dependency recovers. Real SQLite abort triggers prove demand admission,
cursor advancement and continuation writes roll back together. Cases cover
restart at the isolation target and after handoff, lost ACK/coalesced hints,
newer maker generations during/after handoff, concurrent revisions and demand
leases, terminal/anchor changes, shared dependency failures and receipt cleanup.

Run the maintained queue fixture with an existing staged NATS binary:

```sh
TMPDIR="$PWD/tmp" SQLITE_TMPDIR="$PWD/tmp" \
  ORDER_QUEUE_TEST_NATS_BINARY="$PWD/src-tauri/resources/runtime/nats/nats-server" \
  yarn workspace @artgod/indexer test:orders:queues
```

This command bundles a maintained child worker using the existing esbuild
dependency, starts the pinned NATS version on loopback, and keeps all stores
under worktree `tmp/order-queue-healing-nats/`. It downloads nothing and never
opens app-data storage. It proves that small-maker and token work completes
after the heavy maker's first 100 validations, all 9,339 finish without consuming
failure attempts, and 200 additional old maker hints add no validation pass or
run rows. At most one outbox continuation exists for the run. It
also holds both shared validation permits on RPC, applies a lifecycle fill while
they are held, and verifies targeted token work finishes before the broad sweep.
The maximum stays at two active validations. It
then kills its child while the second context is awaiting RPC, restarts NATS
against the same synthetic store, and resumes the remaining 410 of 510 orders.
The recovery fixture advances its injected clock past the persisted lease;
it does not wait two real minutes. Results use deterministic fake RPC, so they
establish scheduling/replay behavior rather than live throughput or native QA.
The same fixture injects a persistent failure into a 250-order maker scan,
observes 249 resolved orders and one durable handoff with all broker messages
acknowledged, then restarts worker and NATS. Only the remaining order is validated
after recovery; an empty broker queue is not mistaken for an empty demand table.

`tests/order-processing.test.ts` covers FIFO admission, error release and the
lifecycle boundary. The backend's `integration/order-lifecycle.test.ts` uses real
migrations, domain transitions, read models and HTTP adapters: a processed sale
removes the ask while the already-applied owner and sale activity remain intact.
Run it with `yarn workspace @artgod/backend test integration/order-lifecycle.test.ts`.
`yarn workspace @artgod/frontend test:listings:history` exercises the maintained
rendered fixture for sold-token asks and retained daily history. That fixture is
separate from native/live queue qualification.

The same `test:orders:queues` command runs `integration/order-backlog.test.ts`:
10,002 legacy envelopes (7,719 validation hints, 2,281 cancellations and two fill
facts), plus 1,000 arriving hints across 50 additional orders. It uses the actual
paced legacy handler, stops and resumes its child, verifies committed domain
state and bounds demand rows without a per-envelope outbox. Malformed bytes and
an unsupported future update remain stored through broker restart. Its concise
result and bounded progress samples are under `tmp/order-backlog-nats/`.

The September 24 synthetic run completed 11,002 supported envelopes in 64.4 s:
170.9 completions/s against 44.2 arriving hints/s, 281 full validations and 1,124
contract reads with a 2 ms fake delay per read. Demand peaked at 250 identities;
there were no validation outbox rows. Worker CPU totaled 17.4 s, admission/domain
SQLite work 6.0 s, peak worker RSS 143.7 MiB, and total allocated database growth
228 KiB (including canonical updates and indexes, not metadata alone). Sampled
unsatisfied demand age settled to zero. The oldest terminal input began 18 hours
old and was applied about 64 s later. These costs include fixture instrumentation;
they are neither real-provider throughput nor a six-million-message ETA.

`tests/legacy-order-admission.test.ts` injects demand/terminal transaction failures
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

## OpenSea Reconciliation Regression

`tests/opensea-reconcile.test.ts` uses disposable migrated SQLite databases to
verify epoch comparisons, inclusive date boundaries, snapshot fallback, separate
startup/periodic thresholds, queue-delay admission, backlog suppression, failure
and retry, manual refresh, collection removal and complete listings-plus-offers
observations. `tests/worker-runner-lease.test.ts` covers long handlers, failure,
shutdown waiting and renewal-timer cleanup. Consumer-policy updates are covered
in `tests/nats-consumer-config.test.ts`.

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

| Case                                    | Required behavior                                                                                                                                              | Maintained coverage                                                                                                                                                  |
| --------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Standalone Enumerable contract          | Address-only diagnostics and explicitly accepted fields can lead to whole-contract queueing; enumeration remains a user choice.                                | `frontend/e2e/bootstrap-probe.spec.ts`, `backend/src/application/use-cases/bootstrap/probe-collection-contract.test.ts`                                              |
| Shared Enumerable contract              | The exact sample is used; capability does not overwrite the user's project range.                                                                              | The same UI/use-case suites and `backend/src/infra/bootstrap/viem-bootstrap-contract-probe.test.ts`                                                                  |
| Misleading supply or an unminted sample | No range inferred from a minted counter; ownership precedes metadata, and correction preserves staged scope and media fields.                                  | Probe adapter/use-case suites and the unminted-sample UI scenario                                                                                                    |
| Sparse range or explicit list           | Anchor reads seed only confirmed present IDs; uncertain errors fail, and an entirely absent anchor set is rejected.                                            | `indexer/tests/bootstrap-token-enumeration.test.ts`, `indexer/tests/bootstrap-token-ownership.test.ts`                                                               |
| Optional marketplace identity           | One exact NFT request, matching/mismatching slug, missing NFT, and no boundary or contract fallback; unresolved OpenSea does not block valid onchain queueing. | `backend/src/application/open-sea/open-sea-collection-identity-verifier.test.ts`, `shared/network/opensea-contract-lookup.test.ts`, probe use-case/API and UI suites |
| Explicit editing and recovery           | No requests on edits; clearing media fields retains the sample; apply is explicit; out-of-scope samples and invalid lists are rejected.                        | `frontend/e2e/bootstrap-probe.spec.ts`, `frontend/src/lib/bootstrap-contract-probe.test.ts`, `indexer/tests/bootstrap-api-trigger.test.ts`                           |
| Late OpenSea setup                      | Resolve/start use one positively owned local token; unavailable ownership and startup capability have distinct recovery states.                                | `backend/src/application/use-cases/collections/start-opensea-collection-sync.test.ts`, `backend/src/api.test.ts`, collection UI scenarios                            |

Run the maintained desktop/mobile browser coverage with
`yarn test:bootstrap:probe`; see [UI testing](../ui/03-testing.md) for the
harness and rendered-inspection boundary. These frontend requests and backend
RPC/marketplace dependencies are mocked. Passing them is not evidence of live
OpenSea availability, a real collection bootstrap, or crash-safe task seeding.
Keep public addresses in optional manual regression guidance, not as a reason
to require credentials or live network calls in deterministic tests.

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

Use **Grailers DAO** to keep range boundaries independent from minted samples:

- Ethereum contract: `0xd89239186180617cfe17e8b73b2b8bd9c96d0a15`
- sample: `2`; first ID: `1`
- intended published supply: `999`; inclusive range: `1..999`
- OpenSea slug: `grailers-dao`

The pre-implementation source investigation found that migration claims
preserved legacy token IDs without incrementing the direct-mint supply counter;
this explained a reported `totalSupply()` of `40` despite many more owned
tokens. Legacy public minting started at `1`, while later direct minting used
a mutable next-token value initially set to `821`. The historical OpenSea
checks found token `1` missing but token `2` associated with the expected
slug. Absence of token `1` was not evidence that the intended scope began at
`2`.

This is retained diagnostic context, not a current minted count, immutable cap
guarantee, or generic contract rule. Recheck sample ownership/metadata when
performing manual QA. The regression invariant is that `1..999` can remain the
requested range while sample `2` drives preview and the single-NFT slug
lookup; neither endpoint of that range must be queried to resolve the slug.

### Manual Verification Boundary

Probe-only QA can exercise the form without queueing a real bootstrap:

1. Stage a fixture, leave whole-contract enumeration off for its manual range,
   and verify that edits make no probe requests.
2. Press **Probe**, review/apply the metadata fields, and verify that the sample,
   first ID, and supply retain their distinct meanings.
3. Inspect the request parameters: OpenSea resolution uses only the sample,
   never range boundaries, collection inventory, or a contract-only fallback.
4. Correct an invalid sample or metadata field and retry explicitly; check
   recovery without losing the other inputs.

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
- The DB-backed project intentionally owns migration and repository behavior;
  adding an in-memory mock for those tests would hide the contracts they exist
  to verify.
