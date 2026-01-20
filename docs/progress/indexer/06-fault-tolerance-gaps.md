# Blueprint Gaps: Fault Tolerance and Scalability

This file lists items described in `docs/blueprint/06-fault-tolerance.md` that are not fully implemented yet.

## Reorg Handling

- Resync uses backfill jobs rather than an explicit realtime resync pipeline.
- No time-delayed block checks (checks are scheduled by depth, not by time).

## Write Buffers

- No write-buffer queue to serialize `nft_balances` updates during backfill.

## Redis Caching and Locks

- No shared RPC cache (in-memory cache only).
- No distributed locks for token refresh or collection stats jobs.

## Circuit Breakers and Rate Limiting

- No circuit breaker to pause consumers on sustained RPC failures.
- No explicit rate limiter adapter for RPC calls.

## Resilience Gates

- No gap check after persistence to requeue missing blocks.
- No special handling for RPC eventual consistency (zero-log retry).
