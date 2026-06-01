# Bidding Bot Logging Revamp

Status: discovery complete, awaiting implementation start.

This note captures the settled context and planned review slices for revamping
the `trading` workspace bidding bot logs so runtime output matches ArtGod's
structured JSON logging contract.

## Current Context

- ArtGod runtime logs are JSON Lines.
- Loki/Grafana parsing expects JSON payloads with stable `t`, `level`,
  `component`, and `action` fields.
- The shared TypeScript logger writes `t`, `level`, `msg`, and any structured
  metadata fields passed by the caller.
- Alloy extracts `t`, `level`, `component`, and `action`; other fields remain
  queryable in the log payload.
- The desktop supervisor now preserves structured child-process JSON at the
  start of the line, adds bounded `process` and `stream` fields, and wraps
  non-JSON child output in a JSON envelope.
- Desktop lifecycle JSON from trading bots is written as parseable JSON Lines
  with `action` inferred from `event` when needed.

## Problem

The bidding runtime still carries many imported logging patterns:

- message prefixes such as `[bidding]`, `[Bidder]`, and `[OpenSeaBiddingService]`
  encode component identity in free text
- key signals are packed into `msg` with ad hoc `key=value` fragments
- component/action fields are usually absent from trading logs
- startup failures still use raw `stderr` writes in bot entrypoints
- OpenSea SDK, stream, snapshot, WETH allowance, command reconciliation, and bid
  decision logs use different message shapes for similar concepts

This makes Grafana queries depend on message parsing instead of structured JSON
fields.

## Logging Contract

Trading logs should use:

- stable `component` values for each runtime/application/adapter boundary
- stable `action` values for the operation being logged
- concise `msg` text that names the event, not all metadata
- dedicated metadata fields for job, collection, token, offer, transaction,
  snapshot, command, and retry signals
- wei fields for exact EVM values, with optional Ether/Gwei display fields when
  they help operator reading
- `error` or `errorMessage` fields for failure detail, without logging secrets

Do not log wallet private keys, secret envelope payloads, OpenSea secret keys,
or raw request payloads that may contain secrets.

## Primary Files

- `trading/src/utils/bidding-log.ts`
- `trading/src/runtime/bidding-bot-runtime.ts`
- `trading/src/runtime/sniping-bot-runtime.ts`
- `trading/src/runtime/bot-runtime.ts`
- `trading/src/runtime/bidding-runtime.ts`
- `trading/src/runtime/bidding-command-reconciliation-loop.ts`
- `trading/src/application/use-cases/bidding/bidder.ts`
- `trading/src/application/use-cases/bidding/collection-offer-snapshot-service.ts`
- `trading/src/application/use-cases/bidding/bidding-job-command-reconciler.ts`
- `trading/src/application/use-cases/bidding/bidding-bid-book-projection.ts`
- `trading/src/application/use-cases/market/pipeline/lib/*`
- `trading/src/adapters/opensea/*`
- `trading/src/adapters/wallet/viem-weth-allowance-approval-service.ts`
- `trading/src/adapters/jobs/nats-bidding-job-command-signal-listener.ts`
- `trading/src/adapters/bid-book/sqlite-bidding-bid-book-projection.ts`

## Planned Review Slices

1. Add a typed trading log helper.
   - Require `component` and `action` for trading log calls.
   - Keep test-run suppression for low-value debug/info output.
   - Add focused tests around emitted payload shape and secret-safe behavior.

2. Convert runtime and lifecycle-adjacent logs.
   - Bidding runtime startup, shutdown, bootstrap phases, stream subscription,
     command loop, and entrypoint startup failures.
   - Keep lifecycle stdout payloads unchanged because the supervisor consumes
     them as a control protocol.

3. Convert command, snapshot, and projection logs.
   - DB Outbox claim/complete/retry/terminal failure.
   - NATS wake-up handling.
   - Snapshot watch/reconcile/refresh/TTL skip summaries.
   - Bid-book projection success/failure summaries.

4. Convert bidder decision logs.
   - Job execution state, warmup, hot-refresh effects, active-order recovery,
     placement, cancellation, renewal, dry-run actions, and runtime-state
     persistence failures.

5. Convert OpenSea and wallet adapter logs.
   - SDK retry/pagination/recovery logs.
   - Stream normalization/handler failures.
   - WETH allowance and EVM transaction-policy logs.

6. Update docs and run verification.
   - Trading docs should mention structured log fields and component/action
     naming.
   - Run focused trading tests and TypeScript checks before committing.

## Suggested Component Names

- `TradingBotRuntime`
- `BiddingRuntime`
- `BiddingCommandReconciliationLoop`
- `BiddingJobCommandReconciler`
- `BiddingJobCommandSignal`
- `Bidder`
- `CollectionOfferSnapshotService`
- `BiddingBidBookProjectionScheduler`
- `SqliteBiddingBidBookProjection`
- `OpenSeaBiddingService`
- `OpenSeaCollectionOfferSource`
- `OpenSeaEventStream`
- `OpenSeaSDK`
- `WethAllowanceApproval`

## Open Checks Before Implementation

- Confirm whether `action` values should use lower camelCase like existing
  backend/indexer logs, or snake case for Grafana query readability.
- Decide whether to add a shared trading field helper for common job references
  or keep small local mappers near each component.
- Keep the supervisor/Alloy ingestion path out of scope for this revamp unless
  new evidence shows trading bot JSON is still not being tailed in a target
  deployment mode.
