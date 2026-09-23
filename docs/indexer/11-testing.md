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
