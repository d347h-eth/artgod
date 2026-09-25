# Deferred order-processing cleanup

This is the follow-up development inventory for the order-queue healing work.
Carry this document with that branch's merge; implement the cleanup separately.
Priority and status belong to [BKL-067](../planning/01-unified-backlog.md).
The inventory was checked against implementation commit `45aba583` on 2026-09-25.
It describes source findings and proposed work, not completed cleanup or live QA.

## Direction and scope

Public alpha favors a simpler current architecture and explicit breaking changes.
Supporting older executables, preserving superseded internal APIs, and retaining
old queue formats indefinitely are not goals. Prefer deleting obsolete paths and
making one deliberate transition for persisted work where necessary.

Existing queued fill/cancel facts and unfinished durable work need an explicit
disposition. A contract break does not specify that disposition by itself. Plan
a bounded, restartable forward migration, or a separately chosen rebuild for
reconstructible state. Do not silently acknowledge incompatible work, reset
consumers, or delete pending obligations as part of a naming/code cleanup.
Once the transition is complete, remove its runtime compatibility branches.
There is no requirement to make an older binary run against the new state.

The review covers sync/offchain producers, order consumers, validation use cases,
SQLite projection/checkpoint adapters, continuations, recovery/cleanup, tests,
and operational documentation. It includes pre-existing paths made redundant by
the revised processing model. It does not propose a new broker, a rewrite of the
whole pipeline, a bidding-concurrency change, or broad removal of everything
containing the word `legacy` elsewhere in the repository.

## Coverage of workers and loops

| Surface                                                | Current responsibility                                                                                                | Follow-up disposition                                                                                                    |
| ------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| Sync worker                                            | Persists chain facts and emits targeted order jobs plus a no-op order-domain range job.                               | Remove the no-op fanout; update targeted contracts with their consumers.                                                 |
| OpenSea stream/bootstrap/reconcile and offchain ingest | Acquire and normalize source observations, maintain source reconciliation, and publish upserts/lifecycle/token hints. | Keep source acquisition and reconciliation; tighten internal order envelopes and remove unreachable activity enrichment. |
| `orders-domain` consumer                               | Calls an order-domain handler that only logs that the range was ignored.                                              | Remove the producer, consumer, kind, queue vocabulary and handler together.                                              |
| `orders-upsert` consumer                               | Commits canonical state and ordinary validation demand atomically.                                                    | Keep; remove obsolete post-publication return contracts and unused validation opt-outs where confirmed.                  |
| By-ID and lifecycle consumers                          | By-ID accepts the old mixed stream; the dedicated lifecycle route accepts terminal/source facts.                      | Make current responsibilities explicit and retire mixed acceptance after the persisted-work transition.                  |
| Broad maker and token consumers                        | Execute bounded steps through the same maker use case; the broad queue also accepts old token traffic.                | Keep scheduling separation; retire cross-route acceptance and older-worker continuation envelopes.                       |
| Ordinary validation poller                             | Validates pending per-order demand with leases, revisions and generations.                                            | Keep its durable ownership; simplify surrounding obsolete entry points.                                                  |
| Outbox publisher                                       | Publishes durable continuations and other domain follow-ups.                                                          | Keep publication ownership; tighten maker receipt requirements without deleting unrelated outbox uses.                   |
| Maker recovery and replay cleanup                      | Repairs missing wakeups and reaps completed receipts only after replay proof.                                         | Remove old schema fallbacks; review duplicate cleanup entry points and receipt representation.                           |
| Market-data maintenance                                | Retires obsolete orders and expires retirement protection; order deletion cascades to demand.                         | Keep. Completed demand rows and live maker-scope coverage are intentional current state.                                 |
| Dead-letter worker / generic worker runner             | Reports terminal delivery failures and handles ACK/retry policy.                                                      | Review the maker-specific interaction with durable recovery; retain shared behavior required by other workers.           |

Composition is in [domain-worker.ts](../../indexer/src/runtime/domain-worker.ts).
Current behavior remains documented in [queues](02-queues-and-jobs.md),
[orders](07-domain-orders.md), and [recovery](18-order-queue-recovery.md).

## Removal and simplification inventory

The C-identifiers below are local checklist references, not additional backlog
items. All items are deferred. **Remove** identifies an obsolete path with a
known current replacement; **transition** requires handling stored work first;
**review** identifies a conditional simplification, not a finding that its entire
mechanism is unnecessary.

### C01 — Remove the no-op order-domain range pipeline

**Remove; transition the retired subject explicitly.**

- [sync-worker.ts](../../indexer/src/runtime/sync-worker.ts) still constructs and
  publishes `ordersJob` for `DOMAIN_JOB_KIND.OrdersSync` after anchor gating.
  [SqliteOrdersDomain.handleDomainSync](../../indexer/src/infra/domain/orders.ts)
  only logs `order-updates-flow-through-dedicated-jobs`.
- Remove that publisher, `stopOrders` consumer/shutdown wiring and its span,
  `OrdersDomainPort.handleDomainSync`, `DOMAIN_JOB_KIND.OrdersSync`, and
  `QUEUE_NAMES.OrdersDomain`. Targeted order fanout already owns the real effects.
- Define how any retained messages on the retired subject are accounted for
  before removing its durable consumer. Verify the no-op classification; do not
  generalize its disposition to other queues.
- Preserve activity facts-only fanout, metadata current-state fanout,
  `DomainSyncContext` used by those domains, and targeted order anchor checks.
  Update sync/range tests, queue examples, diagrams and the `BKL-001` evidence.

### C02 — Remove the old inline maker executor and its reporting tree

**Remove.** Runtime now calls
[RevalidateMakerOrders](../../indexer/src/application/orders/revalidate-maker.ts).
Production call-site search found no caller of the old
`SqliteOrdersDomain.handleOrderUpdateByMaker`; tests still exercise it.

- Delete `handleOrderUpdateByMaker`, its whole-pass `processMakerBatch` loop,
  `revalidateSeaportOrderWithReporting`, the unused `revalidateSeaportOrder`
  helper, and reporting-only profiles, timers, counters and summaries.
- Delete [order-update-by-maker-reporting.ts](../../indexer/src/infra/domain/order-update-by-maker-reporting.ts),
  `OrderUpdateByMakerRuntimeContext`, the old port method, and their test-only
  references after moving useful assertions to the current use case.
- Remove `filterCurrentStateRows` and its optional anchor-cache plumbing if the
  caller audit still shows only the retired executor. Require explicit finite
  boundary/page inputs in `selectMakerUpdateCandidates`; its unbounded defaults
  and storage-maintenance batch-size default serve the old loop.
- Keep indexed candidate selectors, row mapping, anchor checks,
  `applyValidation`, `applyMakerResolution` and revision/source guards used by
  current checkpoints. Keep current checkpoint logs and RPC counters.

### C03 — Remove direct by-ID RPC validation from the SQLite adapter

**Remove.** [ApplyOrderUpdate](../../indexer/src/application/orders/apply-order-update.ts)
already sends validation hints to durable demand; its SQLite handler is used for
lifecycle effects. The `reason = order` branch of
`SqliteOrdersDomain.handleOrderUpdateById` still performs direct validation for
standalone/test callers.

- Delete that direct-RPC branch, the validation-to-fillable case of
  `statusFromReason`, and associated logging once tests use
  `AdmitOrderValidation` / `ValidateOrderDemand`. Keep the fill/cancel mappings
  needed by lifecycle application.
- Expose a lifecycle-specific operation/port rather than a mixed handler that
  can accidentally bypass demand, strict snapshots and completion fences.
- Preserve direct fill/cancel/source application, cancellation-before-create
  protection, observation ordering, listing-price refresh and bootstrap gating.
  These are current business behavior, including when no order row exists yet.

### C04 — Consolidate validator factories and failure semantics

**Remove redundant wiring; review the error-boundary refactor.**

- [domain-worker.ts](../../indexer/src/runtime/domain-worker.ts) still constructs
  a singleton `validateOrder` and `createSeaportValidationBatchFactory` solely
  for the old adapter execution paths. Remove those constructor dependencies
  after C02/C03, including fixture callers that pass unused validators.
- [seaport-validation-batch.ts](../../indexer/src/application/offchain/seaport-validation-batch.ts)
  exports both a WETH-only factory and the full-order snapshot factory used by
  current maker and ordinary validation. Remove the WETH-only wrapper and its
  admission predicate when callers/tests have moved. Consolidate
  `MakerValidationBatchFactory` and the maker-specific naming of the shared
  snapshot interface in [order-validation.ts](../../indexer/src/ports/order-validation.ts).
- [seaport-validate.ts](../../indexer/src/application/offchain/seaport-validate.ts)
  still translates RPC failures into invalid results; the snapshot wrapper
  records the RPC error separately and throws even when the inner validator
  returned a result. With the standalone path gone, use one explicit contract
  for retryable infrastructure failure versus a real protocol-invalid result.
  Do not simply delete the snapshot's failure detection before its replacement
  covers every RPC/helper failure.
- Preserve the actual full validator, signatures/hash/time checks, pinned reads,
  head/hash/lifetime verification, per-spender wallet sharing, and multicall
  fallback for real provider limitations. Those fallbacks are current resilience.

### C05 — Simplify upsert's former post-publication contract

**Remove obsolete output; review the opt-out.**

- `handleOrderUpsert` and `OrdersDomainPort` expose
  `{ changed, validationNeeded, validationRevision }`, although runtime ignores
  the result and demand is now committed inside the same transaction.
  `validationRevision` has no production caller. Remove unused public outputs;
  retain any internal decision needed for atomic demand admission.
- The only production upsert publisher found,
  [dispatch.ts](../../indexer/src/application/offchain/dispatch.ts), always sends
  `validateAfterUpsert: true`. Check the complete producer/fixture surface before
  removing this opt-out and making domain-owned validation policy unconditional
  for admitted orders that need it.
- Replace old failed-publication comments/tests with the actual atomic-admission
  contract. Preserve unchanged-upsert write avoidance, original observation time
  on retry, current-revision freshness invalidation, and five-minute freshness
  behavior. `validated_at` still has that purpose; it is not a deletion target.

### C06 — Retire mixed by-ID acceptance and clarify lifecycle contracts

**Transition.** The by-ID queue remains a current producer destination for
onchain validation hints. Deleting the queue merely because it was called
"legacy" would strand current work.

- [order-update-handler.ts](../../indexer/src/infra/queue/order-update-handler.ts),
  [ApplyOrderUpdate](../../indexer/src/application/orders/apply-order-update.ts),
  and [order-processing.ts](../../indexer/src/domain/order-processing.ts) accept
  fill/cancel/source jobs on the by-ID route as well as validation hints. Make
  each current route accept its own explicit contract after old mixed contents
  are migrated. Do not keep an old-route forwarding consumer indefinitely.
- Review splitting `OrderUpdateByIdPayload` / `ORDER_JOB_KIND.UpdateById` into
  validation and lifecycle contracts. `reason: string` and a `sourceStatus`
  override currently encode distinct actions in one shape. Centralize any
  replacement vocabulary in the owning domain and update both sync and offchain
  producers together.
- Remove `LegacyOrderAdmission` / `LEGACY_ORDER_ADMISSION_POLICY` naming. Decide
  whether pacing is still needed for current admission; retain it under current
  ownership if useful. The 5 ms limit is resource control, not inherently an
  obsolete behavior. Rename/rebind consumers only with an explicit backlog
  transition because their durable identities have delivery state.
- Audit envelope fallbacks such as collection identity from the outer job and
  missing observation time from `scheduledAt`. Remove application-version
  compatibility where all current producers can supply the field. Keep deliberate
  chain/source attribution rules: a chain hint currently lacks a marketplace
  observation time, and an offchain hint legitimately lacks an onchain block.

### C07 — Make maker/token routing strict

**Transition.** Current producers route token scope to `order-updates-by-token`
and collection/global scope to `order-updates-by-maker`. The runtime only enforces
that scope check on the token consumer; the broad consumer accepts old token jobs.

- Enforce the same queue/scope ownership in both directions once existing token
  jobs and continuations on the broad subject have a forward transition.
- Update [order-update-fanout.ts](../../indexer/src/application/order-update-fanout.ts),
  offchain dispatch, consumer wiring and integration fixtures as one contract.
- This removes a reason that one token-scope run can accumulate origins from
  two consumers. Revisit the receipt model in C10 after choosing the final route.
- Keep separate broad/token scheduling, the shared validation admission limit,
  and chain/maker/selection/bootstrap-mode distinctions in scope keys.

### C08 — Replace continuations designed for older executors

**Transition.** [order-jobs.ts](../../indexer/src/domain/order-jobs.ts) explicitly
keeps the full original maker payload on a continuation so an older worker can
perform the original scan. `makerContinuationJob` reuses `UpdateByMaker` and
adds an optional `{ runId, step }` field; `execute` canonicalizes and compares
both forms.

- Give continuation/resume work an explicit current contract. Evaluate using
  the persisted run as the authoritative payload and carrying only the required
  run/step/chain identity, with routing owned by that contract.
- Remove older-worker execution support, the optional continuation member on
  a fresh trigger, and duplicate payload serialization/comparison if replaced by
  equally strong identity checks. Transition retained continuation envelopes
  and their outbox publications before removing the old decoder.
- Preserve step/version fences, stale-continuation idempotency, wakeup generation,
  chain and queue ownership, and the rule that a cleaned run is not recreated by
  a late continuation. Old-binary support is removable; duplicate delivery is a
  property of the current broker and remains supported.

### C09 — Remove the independent pre-coalescing maker-run format

**Transition.** In
[sqlite-maker-revalidations.ts](../../indexer/src/infra/orders/sqlite-maker-revalidations.ts),
absent `requiredAt` selects `scope_key = NULL`, creating a separate run per job.
Current runtime supplies `job.scheduledAt`. Migration 059 leaves pre-existing
runs independent and payload columns nullable; admission/mapping retain fallback
reads such as `sourcePayloadJson ?? payloadJson`.

- Require a trusted request time at current maker admission. Transition old
  independent pending/completed rows, then remove the nullable scope format,
  partial uniqueness condition and alternate cleanup behavior if no remaining
  current use case requires them.
- Establish non-null source/current/requested payload state during migration
  and remove nullable fallback reads. Preserve the different meanings of original
  request identity, current finite-pass payload and newer requested coverage;
  duplicated-looking fields are not automatically redundant.
- Preserve block/hash disagreement handling, unanchored versus chain-gated
  scope separation, and follow-up generations for changes behind a running cursor.
  Do not infer an old trigger's time or semantics from undocumented job-ID text.

### C10 — Remove duplicated origin storage and review receipt cardinality

**Transition; choose the final representation before editing the schema.**

- Migrations 056/060 and `SqliteMakerRevalidations` keep both inline
  `origin_stream_id`, `origin_consumer`, `origin_sequence` and
  `maker_validation_delivery_origins`. `recordOrigin` dual-writes, and
  `retainLegacyOrigin` lazily copies inline state on admission and cleanup.
- Move any needed inline evidence once, then remove dual writes, lazy copying,
  obsolete `RunRow`/`MakerRevalidationRun.origin` mapping and indexes serving
  only that representation, including reviewing the original completed-run index.
- C07 may establish one owning consumer per scope/run. If that invariant is
  enforced and all prior origins have been settled, assess replacing the
  per-consumer table with one receipt per run. Otherwise retain the table as the
  sole representation. Avoid first removing and then reintroducing the same
  storage in separate cleanup passes.
- Never discard contributing ACK evidence while it can still replay. Keep stream
  incarnation, sequence and ACK-floor checks, invalidation by newer deliveries,
  bounded rotating cleanup, and live-scope coverage retention. Missing evidence
  cannot become a time-based permission to delete.

### C11 — Tighten the maker transport-evidence boundary

**Review, then transition incomplete stored evidence if needed.**

- [QueuePort](../../indexer/src/ports/queue.ts) allows `publish` to return `void`
  and deliveries without origin. Maker use-case/store inputs and replay-boundary
  injection are optional. The NATS implementation supplies those values, while
  older call shapes and test doubles can omit them.
- Decide whether to require evidence through a narrow maker-specific port or
  the shared queue contract after auditing other callers. Update fixtures to
  supply realistic receipts instead of retaining permissive production shapes
  solely for tests.
- Remove optional branches justified only by retired callers once their state
  has a disposition. Keep recovery for a genuinely missing outbox entry,
  publish-success/sent-write-failure, a changed stream incarnation and lost
  execution. A publication marked `sent` is still not proof of completion.

### C12 — Narrow the old combined domain adapter/port

**Review after C01–C05.** `OrdersDomainPort` mixes range sync, maker execution,
by-ID execution and upserts. `SqliteOrdersDomain` still mixes these old entry
points with the current projection ports and internally constructs a demand
adapter while composition constructs another demand adapter over the same store.

- Remove obsolete methods and constructor dependencies before introducing new
  abstractions. Expose the remaining lifecycle/upsert/projection responsibilities
  through the narrow contracts that actually consume them.
- Consider moving remaining admission orchestration into an application use
  case with an atomic persistence port. Keep the single transaction for order
  state plus demand; replacing it with sequential commits would regress the
  reason this branch introduced durable demand.
- Sharing the SQLite connection and having multiple lightweight adapter objects
  is not itself a defect. The benefit sought is one orchestration owner and no
  public bypass around the current validation pipeline.

### C13 — Review maker recovery, cleanup and retry ownership

**Review; these loops are current mechanisms.**

- `RevalidateMakerOrders.execute` runs replay cleanup before deliveries, while
  [recover-maker-revalidations.ts](../../indexer/src/application/orders/recover-maker-revalidations.ts)
  also performs periodic cleanup. After C10, decide whether one scheduling owner
  can provide bounded cleanup during both busy and idle periods. Preserve
  independent advancement of ACK proof and rotating scope inspection.
- Maker consumers retain a five-attempt/log-only-DLQ delivery policy, while a
  persisted pending run has its own recovery mechanism. Review whether those
  two failure owners can be simplified for maker execution after durable
  admission. Admission failure before a run exists needs an explicit outcome;
  it must not be mistaken for recoverable persisted work.
- The generic outbox's terminal publication failure is repaired for maker runs
  by maker recovery. Keep one clear owner for that redrive. Do not change generic
  runner/outbox/DLQ behavior for unrelated domains as incidental cleanup.
- The ordinary demand poller, maker continuation recovery and generic outbox
  publisher own different obligations. Combining or deleting them requires a
  replacement liveness design; they are not old-version support.

### C14 — Remove unreachable offchain activity enrichment

**Adjacent remove candidate, inherited from the earlier order/history shape.**

- [dispatch.ts](../../indexer/src/application/offchain/dispatch.ts) always calls
  `normalizeOffchainActivity(payload, null)` and admits only retained listing
  creation activity. No other production caller supplies existing order state.
- [normalize.ts](../../indexer/src/application/offchain/normalize.ts) still exports
  `ExistingOrderActivityContext` and builds cancellation/invalidation activities
  only when that unavailable context exists. Remove that argument, type and
  unreachable branch. Review avoiding bid-activity construction that this
  dispatch immediately rejects under the current retention policy.
- Keep lifecycle cancellation/invalidation normalization, token owner-side
  revalidation, source retirement protection, listing history and onchain sale
  activities. Do not remove shared activity kinds that other domains still use
  or change the product's history-retention policy in this cleanup.

### C15 — Move verification and documentation onto the current pipeline

**Required companion work; remove old implementation dependencies after porting
the behavior they protect.**

- [orders-heavy-maker.test.ts](../../indexer/tests/orders-heavy-maker.test.ts)
  retains whole-envelope/restart-from-zero benchmarks through the old executor.
  Remove obsolete executable baselines from production dependencies. Historical
  comparison can remain a documented result or isolated fixture if still useful.
- [orders-update-by-maker.test.ts](../../indexer/tests/orders-update-by-maker.test.ts)
  should exercise current scoped selection/checkpoint use cases. Port its token,
  sibling-collection, allowance, counter, anchor and reporting value before
  deleting assertions about the old log family.
- [orders-raw-source.test.ts](../../indexer/tests/orders-raw-source.test.ts) still
  models post-commit publish failure and directly calls the old by-ID validator.
  Express canonical-source, unchanged-retry, cancellation and freshness checks
  through durable admission/validation. Update daily-listing, storage-maintenance,
  offchain-dispatch and shared fixture constructors that inject old validators.
- Move `legacy-order-admission.test.ts` and `order-backlog.test.ts` compatibility
  cases into the chosen transition's tests; retain steady-state tests for
  current admission pacing, retained failures, terminal precedence and useful
  progress. Update missing-time/old-origin maker tests when C09/C10 land.
- Keep the current demand/checkpoint/status-batch tests, real-NATS queue tests,
  [maker queue fixture](../../indexer/tests/fixtures/maker-queue-worker.ts), build
  helper and backend lifecycle integration aligned with production composition.
  Assertions that live only on deleted execution paths do not protect runtime.
- Update `02-queues-and-jobs`, `07-domain-orders`, `11-testing`, `18-order-queue-recovery`,
  sync/overview/sequence references, RPC catalog and backlog evidence. Remove
  obsolete standalone/older-consumer claims and old-route inspection examples
  when their replacement ships. Keep useful inspection and failure semantics.

## Current mechanisms to retain

These are deliberate parts of the revised model, not compatibility debt:

- `order_validation_demand`, captured revision/generation/coverage, fenced
  leases and retry state; completed rows remain useful while their orders exist.
- Finite maker-pass boundaries, atomic results/cursor/continuation checkpoints,
  follow-up generations and current-scope coverage.
- Outbox publication evidence, recovery after a crash or uncertain publication,
  and ACK-based replay safety. At-least-once delivery still applies to one version.
- Shared FIFO validation admission, bounded work, provider timeouts, snapshot
  pinning/canonicality, full validation and real-provider multicall fallback.
- Explicit lifecycle priority; source activity separate from fillability;
  cancellation-before-create protection; bootstrap anchors and reorg semantics.
- Existing current-order retention, retirement records, listing maintenance,
  and deletion cascades. Clearing every table is not a definition of catch-up.
- OpenSea source reconciliation and source-state writes, source timestamp and
  protocol-data normalization, and deliberate handling of missing external data.
  They cannot be replaced by the validation-demand table.
- Current NATS ACK/lease/stream-incarnation handling and acknowledged-leftover
  maintenance. Broker behavior and uncertainty are separate from supporting old
  ArtGod workers; an `older brokers` comment alone does not justify removal.

General SQLite startup recovery and its old market-row format are a separate
storage workstream (`BKL-066`). Funding-only validation, immutable signature
caching, broader event coverage (`BKL-033`) and generic queue backpressure remain
separate outcomes; they are not prerequisites for removing these old paths.

## Suggested implementation sequence

1. **Delete unreachable execution and no-op work:** C01–C03, the unused C04
   composition dependencies, C14, and corresponding C15 tests. Resolve the
   no-op subject transition explicitly. Keep behavioral coverage on current paths.
2. **Consolidate current APIs:** finish C04/C05 and the narrow scope of C12.
   Make infrastructure failure propagation explicit and retain atomic admission.
3. **Choose the one-way state/queue transition:** design C06–C11 together so
   strict routing, continuation identity, scope coalescing and receipt storage
   have one final representation. Avoid successive migrations that undo each
   other's simplifications. Work on disposable old/new fixtures first.
4. **Apply that transition and remove bridges:** migrate only supported retained
   work; account for excluded work explicitly. Verify a fresh store and a resumed
   partially transitioned store. Retire old consumers only after their obligations
   and replay evidence have been handled. Remove compatibility code at the end.
5. **Review remaining loop ownership:** C13 where evidence supports a smaller
   design; finish C15 documentation/observability. Defer redesigns without a
   concrete benefit instead of expanding this cleanup indefinitely.

For a persisted transition, define the cutover boundary, authoritative source
state, finite cursors, durable destination-before-source-ACK ordering, duplicate
handling, unknown-input handling and crash restart behavior. These belong to the
transition implementation, not permanent dual steady-state handlers. Use the
repository migration workflow for already applied schemas; deleting historical
SQL files alone does not change an existing store. A separate fresh-schema
baseline/reset decision would need its own explicit scope.

## Follow-up verification and progress

Implementation is intentionally unchecked:

- [ ] Confirm the inventory against the merge result and record final decisions
      for review items before deleting their mechanisms.
- [ ] C01–C03/C14: obsolete call paths and no-op fanout removed; meaningful
      behavior covered through current execution.
- [ ] C04/C05/C12: one validation/error contract and narrow current ports;
      atomic admission and canonical freshness still covered.
- [ ] C06–C11: current producers/consumers agree; old persisted formats have one
      explicit forward transition; no indefinite mixed-mode decoder remains.
- [ ] Transition tests cover interruption before/after destination commit and
      source ACK, duplicate publications, pending demand and leased maker runs,
      outbox retry/sent uncertainty, multiple old consumer origins, null-scope
      runs and unknown input without silent loss.
- [ ] Current pipeline tests cover changed revision/new generation during RPC,
      terminal precedence, anchor changes, RPC uncertainty/reorgs, late steps,
      maker fairness, finite follow-up completion, cleanup and bounded metadata.
- [ ] C13: any simplified recovery/retry ownership has failure and restart proof;
      unrelated domains retain their existing obligations.
- [ ] C15: remove superseded tests/contracts/docs; retain full-order semantics,
      pinned-read/status-batch coverage, backend lifecycle and current queue tests.
- [ ] Run affected package tests/type checks and runtime bundling when composition
      changes; run `yarn workspace @artgod/indexer test:orders:queues` with the
      documented disposable broker fixture when routing/recovery changes.
- [ ] Run `yarn check:docs`, `yarn test:docs`, scoped Prettier and `git diff --check`.
      Native/live qualification remains a separately coordinated run.

Record implementation decisions beside the relevant C-item and update BKL-067
as work lands. Documentation of this inventory does not mark any cleanup done.
