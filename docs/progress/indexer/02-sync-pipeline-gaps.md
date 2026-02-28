# Blueprint Gaps: Sync Pipeline

This file lists items described in `docs/blueprint/02-sync-pipeline.md` that are not fully implemented yet.

## Scheduling and Head Management

- Backfill API for manual range submission is not implemented (only internal helpers exist).
- No scheduler-worker-side cache of `eth_getBlock` results to reuse in workers.

## Sync Execution

- No write buffer queue or dedicated writer for backfill workloads.
- No focus-mode filtering after decode (only address filtering in `getLogs`).

## Domain Handling

- No Seaport/Blur handlers or payment handlers.
- No order fill, cancel, or payment extraction.

## Post-Processing Hooks

- Transaction cache for realtime mode is not implemented.
- Block-check scheduling is not tied to per-block persistence; it is driven by scheduler-worker only.
