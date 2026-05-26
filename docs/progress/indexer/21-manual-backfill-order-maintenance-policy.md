# Manual Backfill Order-Maintenance Policy

Status: slices 1-3 implemented; slice 4 deferred.

## Context

`docs/progress/indexer/20-domain-queue-backlog-analysis.md` showed a manual
historical backfill creating 6,236 pending `order-updates-by-maker` messages.
The queue shape was dominated by global maker revalidation jobs:

- 5,590 `global:erc20-balance`
- 460 `global:order-counter`
- 26 `global:approval-change`

These messages are current-state order maintenance triggers. They are not
historical facts by themselves. The sync path persists historical facts such as
blocks, transfers, fills, activities, and extension event facts separately.

## Current Behavior

The `events-sync-backfill` queue is overloaded today:

- manual blockspace backfill jobs from backend publish `sync:manual:*`
- reorg recovery jobs publish `sync:reorg:*`
- bootstrap catch-up jobs publish `sync:bootstrap:*`
- realtime gap repair publishes `sync:gap:*`

All of these now use the same explicit `BackfillSyncPayload` shape:

```ts
type BackfillSyncPayload = {
    fromBlock: number;
    toBlock: number;
    source: BackfillSource;
    orderMaintenancePolicy: BackfillOrderMaintenancePolicy;
};
```

The payload says whether the backfill is historical fact enrichment or
current-state repair. Existing queued messages may be discarded before this
branch is run, so there is no legacy/default compatibility path for old
two-field payloads.

WETH balance and approval events are already guarded by the bidder index before
queue fanout:

- the sync worker refreshes a current maker index from local buy orders
- WETH logs are fetched only when the index is active and a current-state
  projection window exists
- decoded WETH makers are emitted only when they are present in that current
  bidder index

This guard works, but it answers the wrong question for long historical
backfills. It asks "is this address currently relevant to our orderbook?" and
then replays every old WETH transfer for that address. For a months-long manual
range that can still create thousands of current-state validations from stale
events.

Seaport `CounterIncremented` events are different:

- they are not bidder-index guarded
- they affect all Seaport orders from that maker, not only buy offers
- the bidder index is currently buy-side only, so it is not a valid guard for
  counter events

If counter events are kept for any manual backfill path, they need a separate
guard such as "maker has local Seaport orders" rather than the bidder index.

## First-Principles Assessment

Order maker-trigger jobs revalidate current local orders. The Seaport validator
reads current chain state:

- `getOrderStatus(orderHash)`
- `getCounter(offerer)`
- current owner / approval for sell orders
- current balance / allowance for buy orders

The validator does not evaluate historical state at the trigger block. The
trigger block is attribution and an anchor guard, not a block tag for order
validation.

For a long manual historical backfill, old WETH transfer, approval, and counter
events therefore do not reconstruct historical orderbook state. They repeatedly
ask the domain worker to re-check the current orderbook after each stale event.

That is useful for recent recovery backfills, but usually redundant for broad
historical enrichment:

- realtime sync already tracks new current-state WETH/counter events after the
  app is live
- order upsert validation already reads current counter, balance, and approval
- periodic OpenSea reconcile can refresh source-visible state
- an explicit order validation sweep would be a cleaner repair tool than
  replaying months of stale maker-trigger events

## Recommended Policy

Do not suppress all `events-sync-backfill` order fanout globally. Some backfill
jobs are current-state repair jobs and should keep existing behavior.

Instead, make order-maintenance intent explicit on the backfill job contract.

Implemented contract:

```ts
const BACKFILL_SOURCE = {
    ManualHistorical: "manual_historical",
    ReorgRecovery: "reorg_recovery",
    BootstrapCatchup: "bootstrap_catchup",
    GapRepair: "gap_repair",
} as const;

const BACKFILL_ORDER_MAINTENANCE_POLICY = {
    CurrentState: "current_state",
    SkipGlobalMakerRevalidation: "skip_global_maker_revalidation",
} as const;

type BackfillSyncPayload = {
    fromBlock: number;
    toBlock: number;
    source: BackfillSource;
    orderMaintenancePolicy: BackfillOrderMaintenancePolicy;
};
```

Producer mapping:

- manual blockspace historical backfill:
  `source = manual_historical`,
  `orderMaintenancePolicy = skip_global_maker_revalidation`
- reorg recovery:
  `source = reorg_recovery`, `orderMaintenancePolicy = current_state`
- realtime gap repair:
  `source = gap_repair`, `orderMaintenancePolicy = current_state`
- bootstrap short catch-up:
  `source = bootstrap_catchup`, `orderMaintenancePolicy = current_state`

Sync-worker behavior for `skip_global_maker_revalidation`:

- do not fetch WETH logs for the range
- do not publish global maker update jobs for:
    - `erc20-balance`
    - `approval-change`
    - `order-counter`
- keep raw historical facts and activity projection unchanged
- keep current-state repair behavior unchanged for reorg/gap/bootstrap backfills

Token-scoped maker triggers can be evaluated separately. They were a small part
of the observed backlog, and they have tighter collection/token attribution.
The first slice should target the global fanout that created most queue pressure.

## Why Keep Processing Manual `order-counter` Events?

There are legitimate arguments for keeping `order-counter` during manual
backfill:

- A Seaport counter increment invalidates all prior Seaport orders from that
  maker. That includes sell asks and buy offers.
- If source ingestion missed an old counter bump and OpenSea still shows stale
  active orders, replaying the counter event can force current validation.
- Counter events are protocol-native and more semantically direct than WETH
  balance churn.
- The observed `order-counter` volume was much smaller than WETH balance volume.

Those benefits are strongest when the manual range is being used as current
state repair after a recent outage or data gap.

For broad historical enrichment, the costs outweigh the benefits:

- current validation reads the maker's current Seaport counter anyway
- replaying every old counter event does not preserve historical order states
- a maker with no local Seaport orders will no-op only after spending queue and
  worker capacity
- if repair is the goal, a targeted "revalidate current local orders" job is
  more explicit and cheaper than replaying historical counter logs

The recommended first policy is therefore to skip `order-counter` under
`manual_historical` backfill. If a future UI/API exposes "manual current-state
repair" as a separate mode, that mode can keep counter fanout and guard it with
"maker has local Seaport orders" instead of the bidder index.

## Implementation Plan

### Slice 1: Contract And Producers

- Done. Added source and order-maintenance policy constants in
  `@artgod/shared/types/sync-backfill` and re-exported them from
  `indexer/src/domain/sync-jobs.ts`.
- Done. Extended `BackfillSyncPayload` with required `source` and
  `orderMaintenancePolicy` fields.
- Done. Updated manual backend publishing in
  `backend/src/infra/sync-backfill/nats-sync-backfill-command-queue.ts` to set
  `manual_historical` and `skip_global_maker_revalidation`.
- Done. Updated reorg, bootstrap, and gap producers to set `current_state`
  explicitly.
- Intentionally not done. Old queued two-field payloads are not supported on
  this branch because current local queues can be wiped before restart.

### Slice 2: Sync Worker Policy Gate

- Done. Resolve the policy once per backfill job in `sync-worker`.
- Done. Pass the policy into `processRange()` and the order fanout helper.
- Done. Skip `appendWethMakerInfos()` for
  `skip_global_maker_revalidation`.
- Done. Filter global maker triggers in `publishOrderUpdateJobs()` when the
  policy is `skip_global_maker_revalidation`.
- Done. Keep current-state fanout unchanged for realtime, reorg recovery, gap
  repair, and bootstrap catch-up.

### Slice 3: Tests

- Done. Add a focused sync-worker/publisher test showing manual historical backfill
  does not fetch WETH logs and does not publish global `orders.update-by-maker`
  jobs.
- Done. Add regression coverage that current-state policies still publish global
  maker updates.
- Intentionally not done. Missing policy fields are not accepted because existing
  local queued messages can be wiped.
- Done. Add a doc-oriented test or fixture for `order-counter` to prove it is skipped
  only for manual historical policy, not by bidder-index membership.

### Slice 4: Operator Follow-Up

- Surface the policy in blockspace/manual-backfill status so operators can see
  whether a run is historical enrichment or current-state repair.
- Consider adding a separate current-order validation command:
  "revalidate current local orders" by collection, maker, or full orderbook.
- If a future manual current-state repair mode is added, guard counter fanout by
  local Seaport-order maker presence rather than the buy-side bidder index.

## Non-Goals

- Do not change historical facts persistence.
- Do not suppress all backfill current-state repair.
- Do not use the buy-side bidder index to decide Seaport counter relevance.
- Do not introduce automatic heuristics based only on range length in the first
  slice; make the producer's intent explicit.
