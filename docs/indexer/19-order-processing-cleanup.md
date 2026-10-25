# Order-processing reconciliation

The sync/validation revamp established one chain coordinator and one full-order
validation lane. The subsequent bounded cleanup traced production registration,
callers, durable state and failure owners before removing redundant paths. This
record replaces the original deferred checklist: its older proposed queue/state
compatibility project is outside the current-operation scope.

The operating contracts are [sync](04-sync-pipeline.md),
[orders](07-domain-orders.md), [queues](02-queues-and-jobs.md) and
[recovery](18-order-queue-recovery.md). This reconciliation does not authorize
live queue administration, provider experiments or an existing-state recovery run.

## Final execution paths

| Input                              | Runtime and owner                                                                     | Durable handoff                                                                                      | Execution / completion                                                                             |
| ---------------------------------- | ------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| Shared or collection onchain range | Sync worker, `AutomaticSyncExecutor` -> `processSyncRange` -> `SqliteSyncRangeCommit` | Facts, canonical order effects, admitted maker continuations and applied progress in one transaction | Current application has one single-flight owner. Activity/metadata outbox publication is separate. |
| Historical range                   | Manual handler or coordinator's historical work                                       | Facts and historical-safe activity publication                                                       | Does not create current-order authority, even above an anchor.                                     |
| Canonical by-ID event              | Sync writer -> `RetainCanonicalOrderEffects` -> order projection                      | Cancellation or ordinary validation requirement before applied progress                              | No duplicate event queue, range no-op or by-ID consumer.                                           |
| Canonical maker/token event        | Same writer -> `SqliteMakerRevalidations.admit/scheduleWakeup`                        | Indexed candidate existence check, finite run and one compact continuation                           | Irrelevant owners produce no run/publication; later orders get their own initial demand.           |
| Source declaration/update          | Offchain ingest -> upsert or lifecycle handler -> atomic source admission             | Immutable declaration, source-specific facts and causal demand                                       | ACK after retention; no receipt lookup, source completion assertion or RPC wait.                   |
| Source maker/token hint            | Strict broad/token handler -> `RevalidateMakerOrders`                                 | Scope, delivery receipt and finite candidate boundary                                                | Expand ordinary demand in bounded atomic pages; no maker RPC executor.                             |
| Maker continuation                 | Same handler, explicit `orders.continue-maker`                                        | Chain/run/step points at persisted scope and payload                                                 | Reject wrong chain/route/step; late delivery does not recreate a cleaned run.                      |
| Ready ordinary demand              | Domain worker poller -> `ValidateOrderDemand`                                         | Claims capture checkpoint, order/generation/revision and lease                                       | Exact-hash full proof and compatible covered demand commit together.                               |

## C01–C15 disposition

| ID  | Original subject                              | Final decision and surviving obligation                                                                                                                                                                                                                                                                                       |
| --- | --------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| C01 | No-op orders-domain range pipeline            | Removed producer, consumer/shutdown registration, queue/kind and handler. Activity facts and metadata current-state range publication remain. No live purge is performed.                                                                                                                                                     |
| C02 | Inline maker RPC executor                     | Removed by the revamp. Maker execution only expands finite scopes into ordinary demand. Selection, lease/cursor fences and reporting of actual handoffs remain.                                                                                                                                                               |
| C03 | Direct by-ID RPC validator                    | Removed by the revamp. Cleanup also removes duplicate canonical broker publications and the resulting producerless by-ID queue/pacing. Canonical effect contracts remain internal to the sync writer.                                                                                                                         |
| C04 | Multiple validation factories/failure models  | One exact-checkpoint full validator remains. Infrastructure uncertainty retains demand; it cannot commit protocol-invalid status. No funding-only shortcut or extra validator is introduced.                                                                                                                                  |
| C05 | Upsert opt-out and public return values       | Revamp removed the opt-out. Cleanup removes unused public changed/validation/revision output. Internal change detection, atomic demand admission, source observation identity and freshness remain.                                                                                                                           |
| C06 | Mixed by-ID/lifecycle routing                 | Source updates use the lifecycle route with explicit source, collection and observation time. Canonical events use the sync writer. Outer-envelope metadata fallbacks, mixed canonical transport and the idle by-ID route/pacing are removed.                                                                                 |
| C07 | Maker/token route compatibility               | Both directions enforce exact scope ownership. Compact resume checks persisted scope as well as envelope chain. Independent main/gap consumer receipts remain necessary.                                                                                                                                                      |
| C08 | Older-worker full-payload continuations       | Replaced by chain/run/step identity. Persisted payload is authoritative; lease/version/generation and stale-step handling remain.                                                                                                                                                                                             |
| C09 | Independent null-scope runs/payload fallbacks | Runtime alternate shape and fallback reads are removed. Migration 088 discards unsupported null-scope/source/requested-payload runs and linked wakeups; current-format work is preserved. Historical nullable DDL is inert.                                                                                                   |
| C10 | Duplicate inline/table origin storage         | Migration 088 removes inline columns/index; the per-consumer receipt table is authoritative. Multiple origins cannot be collapsed because main and gap consumers have independent ACK floors and stream identities.                                                                                                           |
| C11 | Optional transport evidence                   | Maintained maker handler requires real delivery evidence before execution. Originless canonical admission is a separate direct writer operation. Generic queue publication contracts still serve other domains and are retained.                                                                                              |
| C12 | Combined adapter/public context               | No-op domain-sync method, unused maker runtime context and upsert result are removed. Narrow projection/selection ports remain; multiple lightweight SQLite adapter objects are not another executor.                                                                                                                         |
| C13 | Retry/recovery/cleanup overlap                | Periodic maker recovery is the only replay-cleanup scheduler. Preadmission failure retains the delivery; after admission, successful durable release transfers retry to the retained run. Uncertain release still retries the message. Ordinary validation, maker recovery and generic publication keep distinct obligations. |
| C14 | Unreachable offchain activity enrichment      | Removed the unused existing-order argument/type and cancellation branch. Listing/bid normalization, retained listing history, source availability and canonical sale activities remain.                                                                                                                                       |
| C15 | Old-path fixtures and docs                    | Meaningful coverage runs through current handlers/coordinator. Standalone reorg poll loop and dead gate tests are removed; crash/replay, bounded expansion, source delivery and proof coverage are retained. See [testing](11-testing.md#sync-and-order-simplification-qualification).                                        |

Additional demonstrated leftovers removed:

- BidderIndex cache, port, SQLite adapter and tests: no production caller remained.
  Current relevance is an indexed query inside the sync writer, with no stale cache.
- Backfill execution mode/classifier/gate: the only serialized caller was already
  the single-flight coordinator; historical callers bypassed the gate.
- Standalone reorg recovery poller and exclusive configuration: used only by a
  fixture, now replaced there by the real coordinator and loop.
- Public plain-rollback facade: production prepares proof then commits rollback,
  revision and resync atomically; low-level storage rollback tests use a fixture
  helper for that explicit storage contract.
- Obsolete automatic gap/reorg wire payloads, optional-repair decoder and ACK-only
  branches: no producer remained. Manual/bootstrap ingress remains. Its redundant
  source-derived maintenance-policy field is also removed; Applied/Historical
  writer acceptance owns actual projection authority.
- Unused admission/maker RPC observability labels after their executors disappeared.

## Retained mechanism register

| Mechanism                                                                                   | Producer / consumer / cleanup owner                                       | Why it remains                                                                                                                                                                     |
| ------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Head samples, source sequences, shared/scoped applied prefixes and accepted ownership bases | Source admission -> sync coordinator -> ready-demand selection            | Source clocks and sparse headers cannot establish readiness or ownership. Bootstrap base installation and contiguous application have different proofs.                            |
| Pending canonical checks/disputes and recovery journal                                      | Sync commit/validation conflict -> coordinator recovery                   | Hash verification, bounded ancestor proof, atomic rollback/resync and durable backoff survive downtime; there is one recovery scheduling owner.                                    |
| Historical gap records and coverage cursors                                                 | Scheduler discovers -> coordinator executes                               | Optional facts-only completeness is independent of current application authority and has its own bounded progress.                                                                 |
| Source observations/declarations                                                            | Upsert/lifecycle/reconciliation -> order projection/maintenance           | Multiple source facts, signed identity, canonical quantity and positive execution proof must remain separate. Raw debug payloads are optional and not authoritative runtime input. |
| Ordinary demand, generation, admission sequence, canonical requirement and claim            | Source/canonical/maker/freshness producers -> ordinary validator          | New work cannot be lost while an older claim is executing; unready work occupies neither RPC capacity nor a queue slot.                                                            |
| Independent proof and lifecycle attribution                                                 | Validator/canonical writer -> shared/backend positive readers -> rollback | A newer proof can be orphaned while the unchanged lifecycle first arose earlier. Freshness and current order/chain revision still constrain executability.                         |
| Freshness, obsolete-demand sweep and per-order backoff                                      | Ordinary demand owner                                                     | Bounded scheduling and isolated failures preserve progress without repeated source messages.                                                                                       |
| Maker source/current/requested payloads                                                     | Admission -> bounded expansion/follow-up generation                       | Original identity guards replay; current payload fixes this finite pass; requested payload retains changes behind its cursor. These fields are not duplicate meanings.             |
| Maker cursor/boundary/lease/version/step                                                    | Admission/claim/expand/recovery                                           | New arrivals cannot make a pass infinite; crash or duplicate execution cannot skip demand or move a stale cursor.                                                                  |
| Maker scope coverage and current requested requirement                                      | Maker store -> shared positive-read guard                                 | Unexpanded candidates are already invalidated. Proof covering the exact requirement can be usable before the full scope finishes.                                                  |
| Maker outbox receipt, wakeup generation and delivery-origin table                           | Writer/expansion -> outbox -> strict consumers -> periodic recovery       | Lost replies, sent-write failure, missing execution, stream replacement and multiple consumer ACK floors are current-version failure cases.                                        |
| Rotating completed-scope cleanup                                                            | Periodic maker recovery only                                              | Bounded receipt proof and live-scope coverage checks prevent premature deletion and repeated rescans of the same blocked prefix.                                                   |
| Generic worker/outbox, metadata/activity projections and market retention                   | Existing domain owners                                                    | Their obligations differ from validation and remain useful after order-specific duplicate publications disappear.                                                                  |

Neither scan completion nor a `sent` outbox row proves that protocol validation
finished. Current-version replay protection remains required even though
pre-upgrade recovery is excluded. Migration 088 changes only the obsolete maker
format/receipt representation; it does not purge a broker or rebuild source
orders. Valid current rows, including leased work, retain their evidence.

## Correctness correction found during reconciliation

Pending canonical maker scopes previously retained the old revision across
rollback while surviving order proofs were rebound. That exposed proofs whose
maker invalidation had not yet expanded. Rollback now transfers those obligations
atomically before proof rebinding, preserves finite progress and receipts, and
fences old leases. Coalesced orphan requirements use the verified ancestor as a
conservative floor; otherwise an intermediate surviving event could be lost.
This reuses the existing rollback writer and maker follow-up mechanism. It adds
no executor, event journal or full per-order scan. See [reorg handling](06-reorg-handling.md).

## Verification and boundaries

Verification targets actual owners: atomic writer rollback and reopen; no work
for irrelevant WETH owners; coalesced compact continuations; strict source and
maker routing; partial/full-order semantics; finite expansion/generations;
postadmission failures and release uncertainty; multiple consumer receipts;
private-NATS backlog/restart/publication recovery; coordinator proof/rollback,
slow snapshots and competing writers; and affected workspace types/runtime builds.

The primary-checkout development plan records F0–F11, the detailed mechanism
register, commit boundaries and exact local outcomes. Passing disposable tests
is not live-provider, rendered/native, remote-CI, merge or release qualification.
Funding-only validation, broader event capture, generic queue backpressure,
rollback scaling and unrelated startup storage recovery remain separate work.

## Bootstrap lifecycle simplification

The later bootstrap correction removes `collection_ownership_bases` and its
installed/accepted lifecycle. The existing current run, successful Ownership
step, retained Backfill range and collection checkpoint now own the handoff.
Ordinary collection sync starts only at live; delegated Backfill stops at its
fixed target. Per-chain startup retains independent ancestry and no collection
snapshot can veto proven rollback. Reorg invalidation reuses the same collection
cleanup owner as operator purge while preserving configuration, failed-run
diagnostics and cancellation obligations. Final live publication and core run
completion share one writer. OpenSea's first snapshot follows that transition,
using the existing non-blocking steps and worker. These changes add no executor,
queue or table. See [bootstrap](14-collection-bootstrap.md) and
[reorg handling](06-reorg-handling.md) for the current contracts.
