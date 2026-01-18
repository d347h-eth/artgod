# Testing (Indexer)

The indexer currently has a single smoke test that exercises the end-to-end happy path: queue -> sync worker -> domain worker -> database.

Primary files:

- `indexer/tests/smoke.test.ts`
- `indexer/tests/helpers/test-env.ts`
- `indexer/tests/helpers/smoke-config.ts`
- `indexer/tests/helpers/test-helpers.ts`
- `indexer/vitest.config.ts`

## Smoke Test Goals

The smoke test verifies:

1. A backfill job can be published to the queue.
2. The sync worker processes the job and persists blocks/transfers.
3. The domain worker processes derived jobs and writes activities.

The test is intentionally minimal and fast. It is meant to catch regressions in the pipeline wiring.

## Test Configuration

Tests require a `.env.test` file. This file is loaded by `loadTestEnv()` and applied to `process.env`.

Required keys:

- `ARTGOD_DB_PATH`
- `SMOKE_NATS_PORT`
- `SMOKE_RPC_URL`
- `SMOKE_TARGET_COLLECTIONS`
- `SMOKE_RANGE_FROM`
- `SMOKE_RANGE_TO`

If any required value is missing, the test fails immediately (no silent skipping).

## NATS Test Container

`startNats()` uses `testcontainers` to run a local NATS server with JetStream enabled:

- Image: `nats:2.10.17`
- Command: `-js`
- Host port is fixed to `SMOKE_NATS_PORT`.
- Readiness is detected via log output (`Server is ready`).

This ensures the test can run on any machine without manual NATS setup.

## Running the Smoke Test

From `indexer/`:

```
yarn test
```

The test uses `vitest` with:

- `testTimeout = 10s`
- `maxConcurrency = 1`
- Serial execution (no concurrent tests)
- Cache directory set to `.vitest`

## What the Test Actually Does

1. Loads `.env.test` and validates smoke config.
2. Sets the database path and runs migrations.
3. Starts a NATS container.
4. Spawns `dev:sync-worker` and `dev:domain-worker` via `execa`.
5. Publishes a backfill job to the queue.
6. Waits for rows to appear in `blocks`, `nft_transfer_events`, `activities`.
7. Shuts down workers and the NATS container.

## Extending Tests

The current setup is intentionally lightweight so additional tests can be layered on later:

- Integration tests can reuse `startNats()` and spawn only the runtimes needed.
- Acceptance tests can reuse the same environment config loader.
- Load tests can publish a burst of jobs to test scheduling and throughput.
