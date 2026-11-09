# Production Simulation: Properties and Scenario Catalog

Updated 2026-11-08. This catalog defines intended coverage for the authorized
[workbench](06-deterministic-system-testing-strategy.md), not a claim that the
scenarios have passed. Initial source inspection used `24cff044`;
[discovery](05-deterministic-system-testing-discovery.md) records existing
mechanism-level tests. [Execution](08-simulation-workbench-execution.md) owns
local commands and the qualification boundary.

## Properties

Assertions observe committed state and explicit external boundaries. Production
runtime entrypoints, real NATS and real SQLite remain inside the system under
test. Only external services are faked.

| ID  | Required property                                                                                                                                                                                                                                           |
| --- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| P1  | Acquisition commits facts, collection coverage, balances, required downstream intent and acquisition progress atomically. Failure or duplicate delivery cannot advance a partial state or duplicate a business effect.                                      |
| P2  | Canonical acquisition, fork proof and validation evidence respect their identity requirements across actual provider selection/retry. Unavailable or conflicting evidence cannot become invented ownership, token absence or a definitive protocol failure. |
| P3  | Actual recovery removes attributable orphan facts, ownership/activity/coverage and event-specific hints; restores fork ownership/ERC1155 deltas; preserves independent source cancellation, operator declarations and unrelated state.                      |
| P4  | Upsert and demand admission remain durable; stale order revision, generation, chain checkpoint or lease cannot overwrite newer lifecycle state or discharge newer work. Each guard needs its own actually reached checkpoint.                               |
| P5  | Source observation, protocol state, onchain evidence, retirement and receipts retain their distinct meanings. Delayed creation/replay cannot defeat terminal precedence.                                                                                    |
| P6  | After a finite input prefix and explicit healing/fair execution, eligible durable work and canonical owner/history/order/HTTP projections converge to independent expected answers. Expected deferred work is enumerated.                                   |
| P7  | Independent lifecycle work can progress while validation/RPC is blocked; documented foreground/background and maker policies make progress under their declared availability/fairness assumptions.                                                          |
| P8  | Persistent disagreement, missing proof and unsupported recovery produce the specified refusal/pending state and diagnostics, without false success or unrelated deletion.                                                                                   |
| P9  | Backend asks/history/bid-book source selection follow production contracts. Indexed-order fallback cannot become the bot's bidding decision authority.                                                                                                      |

The owning contracts remain [sync](../indexer/04-sync-pipeline.md),
[reorg](../indexer/06-reorg-handling.md), [orders](../indexer/07-domain-orders.md),
[processing ports](../indexer/12-ports-and-adapters.md#order-processing-ports),
[progress](../indexer/18-order-queue-recovery.md#failure-and-progress-interpretation)
and [market authority](../trading/03-market-data-and-scaling.md#authority-model).

Provisional observations are allowed where the product contract allows them.
Current optimistic asks need not be hidden until validation; rollback need not
clear every surviving timestamp. Assert stale-result refusal separately from
those visibility rules. The independent oracle knows the eventual winning fork,
but cannot require ArtGod to know it before sufficient evidence is available.

Completed validation coverage is not automatically reusable after a rollback.
Generic convergence checks the current source revision and actual retained
source-time/event-height requirements, permitting an older cached chain revision.
The stale-result cut separately witnesses a new post-rollback bid generation and
requires its completed proof to use the current chain. Fresh-provider histories
also retain their explicit source-generation and chain-proof checks.

## M0: Qualify Execution Before Product Claims

The current gate includes independent known answers for hot BigInt arithmetic,
SQLite BigInt conversion and fixture cryptography. A reproduced JavaScript or
native-runtime failure is not automatically an ArtGod business defect. Earlier
six-check SQLite/NATS runs do not qualify the expanded runtime gate or a changed
virtual CPU model.

The first workload verifies actual Node/native-SQLite and NATS execution inside
the pinned guest: WAL, competing writers, reopen, durable broker restart,
redelivery after an application commit, and guest entropy/clock behavior.
Record and replay must both report their declared checks and produce identical
raw serial bytes with a nonempty event log, equal guest-visible disk capacity
and identical complete disk contents. An exit-zero emulator process is
insufficient. These checks qualify the execution substrate and selected dependency
contracts; they are not chain/orderbook verification.

## M1: Small System, Adversarial Histories

Use two tokens in a small ERC721 collection, one sell listing and one still-
eligible buy order, a bounded fork above the bootstrap anchor and at least two
fake RPC endpoints. Each endpoint serves coherent responses for its own branch
and tip. Start production runtime processes with their real polling, admission,
weighted transport, database and broker behavior.

The simple serial journey provides a reference outcome:

1. Establish the explicitly declared setup boundary. Submit marketplace and
   chain inputs through actual external-service adapters; acquire, normalize,
   persist and validate through production runtimes.
2. Acquire branch A's transfer/fill and observe owner, sale history and asks
   through real backend HTTP. The sell is the fill/re-admission target; use the
   still-eligible buy for an outstanding validation requirement.
3. Release different provider views to sync and validation. Hold selected wire
   responses; advance/change each provider separately. Do not globally switch
   a single injected RPC object or replace the production selector.
4. Let the real canonical checker detect disagreement, prove a fork, roll back
   and resume retained resync. Observe genuine revision/coverage transitions;
   no direct revision mutation or final outcome seeding substitutes for them.
5. Deliver old responses and queued source/event observations around recovery.
   Assert the allowed intermediate effects and which rejection guards actually
   ran. Independently reobserve/revalidate current source state where required.
6. Heal provider views, close finite producers, mature selected pending checks
   and allow fair execution. Assert canonical owner/history/coverage/order/HTTP
   state plus every relevant durable obligation.

M1 includes a fixed missing-proof/refusal history. It does not require every
larger property clause such as ERC1155 or other-chain preservation; mark those
unexecuted until their own fixtures run.

The combined weighted-provider fork history must retain different endpoint
views concurrently, observe actual completed non-prefix header reads from both,
and record explicit healing before final convergence. Weighted routing with a
global simultaneous view change alone does not establish that boundary. The
ordinary four-command campaign retains its own narrower declared model.

The version-2 weighted history uses B106 against retained A105 so the A105
delayed check cannot mature against the retained endpoint before healing. It
requires the actual retained common ancestor and either that pending check or
an already reached supported recovery. After explicit B106 healing, command E
publishes B107 and starts the immutable tail before waiting for rollback. This
supplies recovery dependencies without treating publication as proof of repair;
the final canonical and HTTP oracles still have to pass. Ordinary campaign E
acknowledgement is unchanged.

Fair recovery requires a sufficiently fresh external chain. An enabled
`headProgress` fixture publishes a finite, timestamp-driven canonical tail after
the deliberate fault window. Existing header timestamps never change; the
authored fork window through block 107 remains intact, while a declared slower
tail can support long runs with the default RPC budget. The producer has an
explicit maximum head. Once published business work drains, freeze that input
before requiring full acquisition and mature checks on the fixed cut. A legal
one-block lag under continuing publication must not prevent this cut. An aged
stationary tip must not be mistaken for healed
dependencies, nor repaired by changing application freshness rules or dropping
durable work from the oracle.

Final acquisition assertions compare exact ERC721 ownership and post-anchor
transfer facts against the independent ledger. Fill assertions compare execution
headers, raw protocol items and collection attributions without parent joins
that could hide orphan children. The initial fill truth table covers the
authored one-ERC721/WETH sale; other payment shapes and extension-owned facts
require their own independent fixtures.

The dedicated `stale-result-safety-cut` case addresses transient writes that
later convergence could hide. Hold the actual A105 bidder-counter reply, then
block every fresh Seaport status reply while real B rollback commits.
A genuine first bid Stream observation creates newer source evidence and demand
before the baseline, while the actual resync obligation remains active. Release
only the old counter before the original attempt could time out. Require its
exact captured lease to record one failed release with the persisted
snapshot-changed-before-commit reason, unchanged target proof/projection and
retained page. A completed B105 read supports the evidence; that numeric read
alone cannot identify its caller. No fresh status response may complete before
the cut, even when no such request has started yet. Only then open fresh replies,
finish resync and require the ordinary final HTTP/chain/order oracles. This earns
snapshot-finish refusal coverage with a source-revision fence also present;
it does not isolate the database checkpoint fence. Missing or expired attempt
evidence is unreached coverage, and control-plane unit guards cannot replace
the required real guest run.

The exact stored failure reason is a deliberate SQLite serialization assertion:
generic maker errors plus an unrelated header read cannot establish this guard.
Fresh validation can start during recovery; the fixture must prove that its
external status gate prevented every completed new status response. It must
not assume a global application recovery gate.

The version-2 committed-validation variant deliberately releases A105 validation
and observes the actual cancelled, source-active bid before switching branches.
It retains the completed bidder-counter-one request/read/transport handoff and
explicit `orders.block_number = NULL`. The current product preserves that
unattributed terminal state; this endpoint verifies retention, not automatic bid
reactivation or a fresh canonical-B proof. Ordinary fork retries can encounter
the same negative protocol view, including after early recovery. Where commit
timing was not observed, a narrowly validated conservative terminal endpoint
establishes only compatibility with that supplied view. Its diagnostics must
not claim actual retention, restored bid executability or stale-result rejection.
Canonical chain/listing/HTTP and durable-work assertions still apply. The
dedicated stale-result cut forbids this alternative and requires its actual
rejection and fresh-proof witnesses.

No application-level barrier can stand in for an unobserved race. In particular,
an old RPC response may fail snapshot verification before the database commit
is attempted. That tests snapshot refusal, not the later checkpoint fence.
Holding a decorated `finish()` continuation is outside the workbench boundary.
Record/replay and guest process control can reproduce genuine runtime schedules;
only a trace showing the relevant cut earns that coverage.

## Deliberate Scenario Families

Each family needs authored initial world/provider states, named external events,
expected intermediate states, healing/refusal endpoint and explicit bounds.
The milestone column is rollout intent; it is not execution status.

| ID    | History and interaction                                                                                                                                           | Properties          | Milestone                     |
| ----- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------- | ----------------------------- |
| SC-01 | Production marketplace admission → validation → branch-A transfer/fill → detected fork → rollback/resync → current observation → HTTP convergence.                | P1–P6               | M1                            |
| SC-02 | Old validation response, delayed source observation and old event delivery overlap actual rollback; record observed before/after admission and commit cuts.       | P2, P4–P6           | M1 foundation; expand M3      |
| SC-03 | Sync receives branch A while validation receives branch B at the same height. Neither provider individually returns malformed data. Heal to the chosen branch.    | P2, P4, P6, P8      | M1                            |
| SC-04 | Sync RPC head ahead of validation head, and reverse; WS heads ahead/behind HTTP, stationary/regressed heads and delayed tips.                                     | P2, P6–P8           | M2                            |
| SC-05 | Header A → numeric state read on coherent B → final header A within one validation/acquisition history. Test actual per-request routing and failover.             | P2, P4, P6          | M2, provider model present M1 |
| SC-06 | Requested block hash unavailable at the next endpoint; pruning/archive gap, unsupported selector, recognized absence versus unknown revert.                       | P2, P6, P8          | M2                            |
| SC-07 | Provider changes branch between calls, retries choose another view, timeout/circuit recovery reintroduces a stale endpoint, disagreeing log/receipt/header views. | P1, P2, P6, P8      | M2                            |
| SC-08 | Sustained provider disagreement or partition. Assert retained obligations and permitted independent progress; heal explicitly and require convergence.            | P2, P6–P8           | M2                            |
| SC-09 | Kill after state commit before broker ACK; redelivery after restart and after dedupe expiry.                                                                      | P1, P4, P6          | M2                            |
| SC-10 | Publication accepted with lost reply, partial required fanout and broker restart. Durable acquisition must not be repeated merely to republish.                   | P1, P3, P6          | M2                            |
| SC-11 | Crash during maker cursor/demand handoff, expiry/replacement of a lease, competing SQLite writers during recovery.                                                | P1, P4, P6          | M2                            |
| SC-12 | REST/stream duplicate creation, old source timestamps, chain fill before/after marketplace sale and delayed create after terminal evidence.                       | P4–P6               | M3                            |
| SC-13 | REST absence while newer stream evidence arrives between update batches; failed/incomplete/repeated-cursor traversal.                                             | P5, P6              | M3                            |
| SC-14 | Independent source cancellation before/after orphan fill, payload retirement and actual rollback; stale REST re-admission.                                        | P3, P5, P6          | M3                            |
| SC-15 | Validation overlaps source cancellation, material canonical change, a new requirement or lease replacement. Distinguish each reached guard.                       | P4–P6               | M3                            |
| SC-16 | Sparse ancestry, missing collection coverage and stationary head; insufficient proof waits, then supported repair enables recovery.                               | P2, P3, P6, P8      | M1 refusal; M3 variants       |
| SC-17 | Fork/check before, at and after configured REORG_DEPTH; deep/out-of-window or anchor-crossing divergence follows the supported refusal/recovery contract.         | P2, P3, P8          | M2/M3                         |
| SC-18 | Manual/bootstrap/realtime/gap ranges overlap; pre-anchor facts versus current ownership/order maintenance.                                                        | P1–P4, P6           | M3                            |
| SC-19 | Reorg while realtime acquisition is in flight; another mismatch during resync; affected scope changes during proof.                                               | P1–P3, P6           | M3                            |
| SC-20 | Validation slots/RPC stall while lifecycle events and maker/gap work compete, then recover at documented allocation policies.                                     | P4, P6, P7          | M3                            |
| SC-21 | ERC721 mint/burn/late transfer, ERC1155 duplicate/batched deltas and fork reversal; unaffected collection/chain sentinels.                                        | P1–P3, P6           | M3                            |
| SC-22 | Expiry/retention boundaries overlap validation, retirement and late replay; required receipts, own-order records and declarations survive.                        | P3–P6               | M3                            |
| SC-23 | Bootstrap pause/retry/reopen and independent source/onchain readiness transition into live sync.                                                                  | P1, P4, P6, P8      | M4                            |
| SC-24 | Indexed fallback versus fresh bot projection and incomplete direct snapshot; canonical orders cannot authorize competitiveness.                                   | P6, P9              | M4                            |
| SC-25 | Startup/shutdown/maintenance and extension-triggered side lanes overlap chain/order recovery without bypassing runtime composition.                               | P1–P9 as applicable | M4                            |

SC-05 began as a source-inspection hypothesis around numeric validation reads.
The retained cohort now contains two reached counterexamples, including actual
weighted routing: a completed current proof accepts another fork's ownership
and exposes an invalid seller listing through HTTP. See the
[execution evidence](08-simulation-workbench-execution.md#current-local-evidence)
for their scope and independent checks. That reproduction does not qualify
every SC-05 variant or authorize unrelated hardening. Preserve failed results;
do not make a bad outcome an expected pass to complete the milestone.

## Exploration and Completion

Bounds belong to a specific history: provider count/views, fork depth, tokens,
orders, actor failures, outstanding requests and chosen release points. Enumerate
legal causal orders where those boundaries are controllable and observable.
Do not reuse the former application-only “24 permutations” count as evidence
of complete runtime schedule coverage.

The current whole-machine campaign also enumerates 24 orders of four external
coordinator commands: canonical switch (E), inventory restoration (R), stream
publication (S) and reply-gate release (V). These are command-order cases.
V acknowledges release of a fixture gate; it does not acknowledge HTTP delivery
or production validation completion. Record those actual boundaries separately
before assigning response-order or stale-commit coverage. Repeated command
orders may reach the same runtime interleaving.

Progress from fixed authored histories to bounded combinations, including
failure before/after commits and healing before/after deferred work becomes
eligible. Report which schedules were recorded, replayed, asserted, unreached
or unsupported. Changing source code requires a new recording; replaying the
old recording is a debugging action.

Liveness assumes explicit dependency recovery and fair execution. Persistent
disagreement may correctly remain pending. REORG_DEPTH alone does not establish
provider agreement or protocol finality. Do not assert immediate global equality
while a provider still reports a competing tip.

Keep the coverage ledger and failure corpus versioned. New unsupported
interactions are findings to model and triage, not silent skips or permission
to alter product guarantees. P2P, multiple-source evidence aggregation, remaining
partial-fill quantity, purge/reimport identity and non-EVM behavior need their
own domain decisions before defining a passing oracle.
