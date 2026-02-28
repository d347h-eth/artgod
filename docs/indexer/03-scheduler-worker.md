# Scheduler-Worker Runtime

The scheduler-worker is responsible for translating chain head updates into sync and reorg jobs. It is the only component allowed to publish realtime sync jobs.

Implementation:

- `indexer/src/application/scheduler-worker.ts` (core logic)
- `indexer/src/runtime/scheduler-worker.ts` (runtime entrypoint)

## Inputs

- RPC provider (HTTP): used to fetch the current head.
- Optional WebSocket head source: emits head updates.
- Queue port: publishes jobs to NATS.

## Bootstrap Sequence

`startSchedulerWorker()` performs a blocking bootstrap before starting any background loops:

1. Fetch current head via `rpc.getBlockNumber()`.
2. Schedule realtime sync jobs for the recent reorg window only.
3. Schedule the initial block-check job for reorg validation.
4. Set `lastScheduled` and `lastChecked` based on the head.

This ensures the scheduler-worker never publishes from an uninitialized head.

## Realtime Scheduling

- The scheduler-worker maintains `lastScheduled` (last head seen and scheduled).
- On each head update, it schedules jobs from `lastScheduled + 1` to `head`.
- Jobs are published to `events-sync-realtime` with dedupe by jobId.

Important invariant:

- The realtime window is always relative to the latest head.
- The scheduler-worker never auto-schedules full historical backfills.

## Reorg Block Checks

Block-check jobs are scheduled after blocks become old enough to be safe from shallow reorgs.

- `reorgDepth` determines the delay.
- The scheduler-worker increments `lastChecked` and schedules `block-check` jobs in order.

If scheduling would fall below block 1, the scheduler-worker logs a warning and skips the check.

## Head Sources

The scheduler-worker supports two head sources:

1. **WebSocket head source** (`ViemWebSocketHeadSource`)
    - Non-blocking, event-driven.
    - Emits heads to the scheduler-worker as soon as the node announces them.

2. **HTTP poller**
    - Runs on a fixed interval (default 12s).
    - Authoritative: fills gaps if the WS path misses a block.

The WS path and poller both call the same `handleHead()` function.

## Manual Backfills

`indexer/src/application/scheduler-worker.ts` contains a `scheduleBackfillRange()` helper. It is intentionally not wired to startup logic. Manual backfills are expected to be triggered via user actions (future API/UI) and then published to the `events-sync-backfill` queue.

## Runtime Entrypoint

`indexer/src/runtime/scheduler-worker.ts` wires the ports:

- Loads config from `.env`.
- Connects to NATS.
- Initializes in-memory cache for RPC calls.
- Creates HTTP RPC provider and optional WS head source.
- Starts the scheduler-worker and installs shutdown handlers.
