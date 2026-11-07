# Deterministic System Testing: Proposed Properties and Scenarios

Status: proposed acceptance catalog, 2026-11-07, source baseline `24cff044`.
None of the unified scenarios below has been implemented or executed by this
discovery. Existing mechanism-level coverage is linked from
[discovery](05-deterministic-system-testing-discovery.md). The
[strategy](06-deterministic-system-testing-strategy.md) defines lanes,
oracle independence, milestones and evidence limits.

## Property Catalog

These are test requirements derived from current contracts. A failing scenario
requires diagnosis; these rows are not assertions that all combinations already
work. Check safety at stable committed observation points, never halfway through
an atomic writer. Use the current public domain constants in implementation.

| ID  | Required property and observation                                                                                                                                                                                                                                                  | Owning contract                                                                                                                                               |
| --- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| P1  | Committed acquisition has matching facts, per-collection coverage, balances, required downstream intent and acquisition progress. Injected transaction failure advances none. Duplicate delivery has no duplicate business effect.                                                 | [Sync](../indexer/04-sync-pipeline.md), [commit port](../../indexer/src/ports/sync-range-commit.ts)                                                           |
| P2  | Parent-linked canonical acquisition and proof are required. A committed rollback fences previously acquired data and validation; failed/unknown RPC leaves recoverable obligations rather than fabricated facts or invalid orders.                                                 | [Reorg](../indexer/06-reorg-handling.md), [validation](../indexer/07-domain-orders.md#coalesced-ordinary-validation)                                          |
| P3  | Recovery removes attributable orphan facts, ownership/activity/coverage and event-specific hints. Fork-hash ownership and ERC1155 reversal reconstruct canonical state; independent source evidence, operator declarations and unrelated chain/collection state survive.           | [Rollback](../indexer/06-reorg-handling.md#rollback-strategy), [order retention tests](../../indexer/tests/reorg-order-retention.test.ts)                     |
| P4  | Canonical upsert and validation demand commit together. Old order revision, demand generation, chain checkpoint or lease cannot discharge newer work or overwrite newer lifecycle state. No writer spans external RPC.                                                             | [Orders](../indexer/07-domain-orders.md), [processing ports](../indexer/12-ports-and-adapters.md#order-processing-ports)                                      |
| P5  | Source observation, protocol state, chain evidence and receipt cleanup keep their declared meanings. Delayed create/repeated delivery cannot defeat terminal replay rules; independent source cancellation survives orphan-chain rollback.                                         | [Orders](../indexer/07-domain-orders.md), [OpenSea sync](../../indexer/src/application/offchain/opensea-orderbook-sync.ts)                                    |
| P6  | After closed inputs, restored dependencies and fair execution, all declared eligible obligations complete and ownership, canonical history, asks and selected HTTP responses equal independent expected answers. Legitimate pending checks/blocked work are explicitly enumerated. | [Recovery progress](../indexer/18-order-queue-recovery.md#failure-and-progress-interpretation), [current asks](../../shared/database/current-asks.ts)         |
| P7  | Lifecycle updates can progress while validation permits/RPC are blocked; bounded foreground/background and maker scheduling eventually progress under their documented admission policy.                                                                                           | [Processing](../indexer/07-domain-orders.md#processing-ownership-and-retained-state), [RPC allocation tests](../../indexer/tests/rpc-work-allocation.test.ts) |
| P8  | A known unsupported proof/finality condition retains the correct pending/refusal state without unsafe rollback, false success or unrelated deletion.                                                                                                                               | [Fork search](../indexer/06-reorg-handling.md#fork-point-search), [bootstrap](../indexer/14-collection-bootstrap.md)                                          |
| P9  | Backend ask/history and bid-book source selection agree with their production read contracts. Indexed order state cannot become the bot's competition/placement input by accident.                                                                                                 | [Market authority](../trading/03-market-data-and-scaling.md#authority-model), [HTTP lifecycle fixture](../../backend/integration/order-lifecycle.test.ts)     |

P3 preserves declarations through automatic recovery. It does not change the
explicit purge operation. P6 does not require unvalidated asks to be hidden:
current optimistic upsert/ask behavior is an intentional separate checkpoint.
P9's trading authority assertion needs a trading boundary test beyond M1's
backend reads.

Rollback does not globally clear validation timestamps or hide all surviving
asks. At P2/P4's stale-completion checkpoint, assert that the rejected completion
cannot change order results or cover current demand; independently assert the
allowed visibility of surviving source/optimistic rows.

## First Joined Journey

Use a synthetic ERC721 collection with an established bootstrap anchor, two
tokens and a short fork strictly above the anchor. The sell order on token 1 is
the fill/re-admission target; the still-eligible maker buy on token 2 is the held
validation target, exercising WETH approval/balance validation. World RPC
serves coherent headers/logs/receipts and pinned protocol reads for branches A/B.
Use existing signed payload/receipt fixtures where compatible; record any
fixture limitations. All amounts and token identifiers remain exact integers.

SC-01 must pass a serial baseline before SC-02 explores concurrency:

1. Establish the trusted initial fixture: collection definition, anchor, token
   identity/metadata and anchored ownership snapshot/checkpoint. This setup does
   not prove bootstrap orchestration. Deliver listing and offer via production
   OpenSea normalization/admission. Observe optimistic upsert and durable demand;
   complete full pinned validation.
2. Acquire branch A's transfer/fill through the real range pipeline and drain
   canonical downstream effects. Observe actual owner, sale history and asks
   through backend use cases/HTTP handlers.
3. Admit a fresh requirement for the still-eligible token-2 buy order and start
   validation. In one schedule, hold a pinned RPC response. In a second schedule,
   let the real snapshot's `finish()` successfully verify A, then hold its
   returned continuation before the demand store's result transaction. Keep
   captured identities and the unmet requirement in the trace.
4. Switch the fixture's canonical branch to B, advance head enough for the
   selected check, detect the mismatch through `RecoverChainReorg`, prove the
   fork, commit actual rollback and execute retained resync. No direct revision
   mutation or final-row seeding substitutes for these operations.
5. Release the old completion. In the first schedule, the real snapshot proof
   must reject A. In the second, require an actual attempted result/coverage
   commit and assert that the store rejects the old chain revision. Deliver a
   current observation and validate the current order at B where required.
6. Close producers and execute eligible work fairly. Check the exact surviving
   source evidence, canonical owner/history/coverage, pending/retained work and
   HTTP asks. Choose a mature endpoint or list the expected recent pending
   canonical checks.

Do not expect an order retired after a fill to reappear without an input or
recovery contract that reconstructs it. Distinguish preservation of cancellation
evidence, deletion of orphan retirement evidence, and re-admission of a current
source observation.

The second schedule isolates the persistence fence: a stale RPC read alone can
fail earlier in `finish()` and never exercise that fence. A test-owned decorator
can delay the continuation after calling the real `finish()`; it must not
replace proof or validation. A deliberate stale-result mutation must reach its
targeted commit path before it counts as detected coverage.

For SC-02 prepare three held external completions: V, the successful old
validation's returned continuation; S, a delayed marketplace observation; E, a
duplicate old event-envelope delivery. Add R, the actual rollback commit. Prepare
proof/work before these events, and enumerate all causally legal orders of
V/S/E/R (at most 24 before constraints), including the six with R first. Use a
fixed history and declared source timestamps. Generate the expected legal list
independently and report any rejected order with its causal constraint. R must
be a real production commit, not a model-only revision change.

Assert each order's specified intermediate result: a pre-rollback event may
apply and subsequently be rolled back; an orphan event first admitted after R
must have no effect. Require final semantics to agree where precedence permits.
Keep one isolated R→V→S→E case so source revisions cannot mask the chain fence.
The earlier pinned-RPC/proof-refusal case is a separate fixed schedule and does
not count toward the V/S/E/R enumeration. Record every reached guard separately.

## Scenario Families and Rollout

Every row needs a manifest, named checkpoints, exact expected intermediate
states, completion/refusal endpoint and property mapping. The milestone column
is proposed rollout, not current status. Existing tests are reusable evidence
for individual mechanisms, not an executed version of these joined scenarios.

| ID    | History or controlled interaction                                                                                                                                                  | Properties          | Milestone / lane                               |
| ----- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------- | ---------------------------------------------- |
| SC-01 | Marketplace admission → full validation → branch-A transfer/fill → detected fork → rollback/resync B → current observation → HTTP convergence.                                     | P1–P6               | M1 deterministic                               |
| SC-02 | Hold old validation both before proof and after successful proof, source observation and orphan event delivery; explore legal release orders and before/after-rollback boundaries. | P2, P4–P6           | M1 deterministic                               |
| SC-03 | Kill after state commit before broker ACK, then redeliver after restart and after dedupe expiry.                                                                                   | P1, P4, P6          | M2 process                                     |
| SC-04 | Publication accepted with lost reply; fail partway through required fanout; reopen broker/store and workers. No RPC reacquisition after durable acquisition.                       | P1, P3, P6          | M2 process                                     |
| SC-05 | Crash during maker cursor/demand handoff; lease expiry/replacement and competing SQLite writer during recovery.                                                                    | P1, P4, P6          | M2 process                                     |
| SC-06 | REST snapshot and stream duplicate creation, out-of-order source timestamps, chain fill before/after marketplace sale; delayed create after terminal evidence.                     | P4–P6               | M3 deterministic                               |
| SC-07 | REST absence while newer stream observation lands between source-update batches; failed/repeated-cursor pagination.                                                                | P5, P6              | M3 deterministic + adapter                     |
| SC-08 | Independent source cancellation before/after chain fill, payload retirement and orphan rollback; stale REST re-admission.                                                          | P3, P5, P6          | M3 deterministic                               |
| SC-09 | Validation starts before source cancellation, canonical material change or new generation; release after replacement/expired lease.                                                | P4–P6               | M3 deterministic                               |
| SC-10 | RPC timeout, wrong hash/height, conflicting providers, unavailable EIP-1898 snapshot and unknown revert at acquisition/proof/validation. Restore a coherent provider.              | P1, P2, P6, P8      | M3 deterministic + adapter                     |
| SC-11 | Stationary/regressed head, sparse ancestors, missing coverage and bootstrap checkpoint; incomplete proof safely waits, then supplied history permits recovery.                     | P2, P3, P6, P8      | M3 deterministic                               |
| SC-12 | Deep fork/no ancestor or fork crossing the bootstrap anchor; unavailable required ownership proof. Assert the exact supported refusal state.                                       | P2, P3, P8          | M1 one refusal; M3 variants                    |
| SC-13 | Overlapping manual, bootstrap, realtime and automatic ranges; pre-anchor facts versus post-anchor ownership/order maintenance.                                                     | P1–P4, P6           | M3 deterministic                               |
| SC-14 | Reorg while realtime acquisition is in flight; newer mismatch during resync; token scope changes while rollback proof is awaited.                                                  | P1–P3, P6           | M3 deterministic + process                     |
| SC-15 | Both validation permits stalled while lifecycle fills/cancels arrive; many-maker scans and gap load compete; recovery at default/low/unlimited policies.                           | P4, P6, P7          | M3 deterministic + process                     |
| SC-16 | ERC721 burn/mint/out-of-order transfers and ERC1155 duplicate/batched delta reversal across the fork.                                                                              | P1–P3, P6           | M2 small fixture; M3 variants                  |
| SC-17 | Same maker/contract/token identifiers on different collections/chains; recover one while the others have queued work and operator declarations.                                    | P3, P4, P6          | M2 sentinels; M3 generated                     |
| SC-18 | Expiry and retention boundaries (before/at/after); maintenance overlaps validation, retirement and delayed replay. Keep required receipts/own-order records.                       | P3–P6               | M3 deterministic                               |
| SC-19 | Independent source and onchain readiness, bootstrap pause/retry/reopen, then transition into live sync and observation.                                                            | P1, P4, P6, P8      | M4 after known bootstrap contracts are decided |
| SC-20 | Bid-book indexed fallback, fresh bot projection and unavailable/partial direct snapshot; indexed data cannot authorize competitiveness.                                            | P6, P9              | M4 trading/backend                             |
| SC-21 | Actual runtime entrypoints with scheduler, budget owner, outbox, demand polling and maintenance; stop/start with retained work.                                                    | P1–P9 as applicable | M4 process composition                         |
| SC-22 | Real wire encoding/decoding with captured OpenSea and RPC fixtures; optional local EVM contract/receipt/reorg cases.                                                               | P1, P2, P5, P6      | M4 adapter                                     |

## Contract Decisions and Deferred Families

The following are explicit discovery items, not automatically passing scenarios:

| Area                                                             | Decision needed before defining a passing oracle                                                                                                                                                                                                                     |
| ---------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Collection/source replacement, purge and reimport during a crawl | Accepted producer identity, generation/admission and settlement semantics. Current existence check does not establish source-generation fencing. See [purge limitations](../backend/01-api-and-application-architecture.md#collection-lifecycle-controls-and-purge). |
| Partial fills                                                    | Remaining quantity and source/protocol lifecycle semantics; current order state is not a full exchange ledger.                                                                                                                                                       |
| Multiple orderbook sources / P2P                                 | Same signed order identity versus independent source evidence, cancellation authority, absence semantics, reconnect/duplicate rules.                                                                                                                                 |
| Cross-chain beyond current EVM model                             | Identity/routing and chain-specific fork/finality capabilities; see `BKL-025` in the [backlog](../planning/01-unified-backlog.md).                                                                                                                                   |
| Extension/metadata side lanes                                    | Select which canonical-trigger/rollback/projection effects enter the joined oracle; image/rendering correctness remains a separate suite.                                                                                                                            |

Known limitations such as bootstrap crash recovery/fencing must be linked to
the current backlog and reported distinctly. New harness failures cannot be
silently marked expected or fixed by weakening the oracle. Resolve whether the
contract, fixture, harness or production behavior is wrong before changing it.

## Measurable Exploration Envelope

For the first exhaustive schedule claim, fix one chain, one collection, two
tokens, two branches, a fork depth of at most two, one held validation, three
named external completions and a rollback commit. Report the exact setup and
legal orders of those four events;
this claim covers those completions only, not all JavaScript, SQLite or NATS
executions. SC-12's refusal has a separate fixed fixture.

Later generated campaigns vary small collection counts, bounded token/order
sets, fork depths within/outside the configured proof window, command histories,
delivery order, duplicate counts and faults. Include both safety under continuing
input and convergence after a finite prefix. Recovery fairness is explicit:
healthy eligible actors cannot be postponed forever by the test driver.

Keep a machine-readable coverage ledger during implementation mapping property
→ scenario → reached checkpoint → assertion → lane → source SHA/result. Report
unreached transitions, illegal/precondition-filtered commands and deliberately
unmodeled cases. No line in this discovery catalog counts as tested coverage.
