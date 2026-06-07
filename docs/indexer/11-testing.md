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

This delegates to workspace-specific runners, so the frontend and indexer each run under their own Vitest config.

From `indexer/` specifically:

```sh
yarn workspace @artgod/indexer test
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

## Practical Notes

- The Vite `spawnSync /bin/sh EPERM` warning can appear in restricted sandboxes. It is unrelated to actual test results.
- DB-backed tests need teardown order to respect current foreign-key chains (`collection_trait_stats`, `token_sets`, `attributes`, etc.).
- Workspace-level orchestration matters: running a single unconfigured repo-level Vitest sweep can bypass workspace-specific config such as the frontend SvelteKit plugin.
