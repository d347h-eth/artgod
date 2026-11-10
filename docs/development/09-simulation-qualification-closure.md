# Simulation Qualification Closure

Authorized 2026-11-09. Complete the five follow-ups below on the existing feature
branch and make the branch ready for merge. Best-effort closure is permitted
when this session's tools, access or environment prevent further qualification;
record the exact limit and the remaining check instead of claiming a pass.

The [unified backlog](../planning/01-unified-backlog.md#simulation-qualification)
owns work status. This document owns scope, acceptance criteria and the evidence
needed to resume work after context compaction. The
[execution guide](08-simulation-workbench-execution.md) owns actual results and
commands; the [strategy](06-deterministic-system-testing-strategy.md) and
[scenario catalog](07-deterministic-system-testing-scenarios.md) remain the
architectural boundary.

## Preserved Baseline

Do not rewrite the existing reports or bless their failed properties. The sealed
cohort at source `63221604` executed all 26 cases with exact serial replay and
complete guest-disk equality: 15 property passes and 11 failures. Only seven of
the twelve campaign histories reached their complete assertions. Its evidence
index is `tmp/simulation-final-cohorts/cohort-8fWEDa/handoff.json`.

The capture guest at source `6d0b6308` passed the expanded eight-check M0, a real
synthetic core-capture probe and independent raw-core inspection. Three fork
diagnostic trials reproduced one sync-worker native crash and two passing
journeys. The domain-only profile captured no actual runtime crash. The final
reporting correction at `68de8eb2` has 318 passing supporting tests; `e232b582`
adds documentation only. No complete cohort has qualified that final source.

The native-host audit reevaluated retained observations with shared oracle/model
algorithms. It did not rerun production, and its neutral proof requirements do
not establish missing source-time or event-height freshness. Actual hosted CI
and arbitrary-host portability remain unverified.

## 1. Native Runtime Failures

Backlog: `BKL-073`.

Determine whether observed native exits belong to the application, a native
dependency, Node/V8 or the simulation engine. Capture the actor that actually
fails, including sync rather than only domain, with sufficient registers,
mapping and stack evidence to choose an informed control. Keep capture bounded
and guest-only; do not change host kernel policy or install host tools.

Qualify changed capture behavior with the maintained synthetic probe and an
independent inspection of the actual retained core. Preserve production
entrypoints, runtime bytes and normal Node flags. Change one relevant execution
variable at a time in separately labelled controls. A native whole-runtime
comparison must retain real SQLite/NATS and external adapters; the existing
snapshot audit is not that comparison. A later non-crash does not clear an
earlier failure.

Acceptance: enough attributed evidence or controlled comparison to decide the
appropriate simulation profile and handle blocked scenario histories. If exact
root cause remains inaccessible, document the supported diagnosis, limits and
merge implication without misclassifying runtime failure as a business oracle.

## 2. Permanent Proof Oracle

Backlog: `BKL-074`.

Extend the existing read-only projection and owning convergence oracle to verify
the current source revision and actual source-time/event-height requirements.
At the preserved baseline, the projection omitted `required_at` and
`minimum_block`; the generic oracle checked only positive validation time,
settled demand and chain revision. Use the owning validation-demand contract,
preserve terminal-source exceptions and existing optimistic visibility, and keep chain truth independent
of production reducers. Do not introduce a stronger product guarantee.

Acceptance: meaningful negative cases demonstrate rejection of stale revision,
time and block coverage, missing required evidence and wrong chain identity;
legal coverage and source-cancelled endpoints remain supported. Reassess old
passes from complete retained evidence where possible, and record fresh runs
where the absent requirements cannot be reconstructed reliably.

The native control exposed an older oracle assumption: a completed cached proof
need not be refreshed solely because the global chain revision changes. Current
chain identity is required for reuse and for independently witnessed new work.
Keep generic retained-coverage checks separate from those fresh obligations;
do not add an unrelated source refresh to hide the distinction.

A second contract review corrected the committed-counter endpoint. Validation
records the terminal result without attributing the order row to that block;
rollback deliberately preserves such cancellations. Separate observed terminal
retention from a weaker permitted terminal outcome whose commit timing remains
unknown. A real negative protocol view must support that alternative, and it
cannot replace the dedicated stale-result cut or weaken unrelated order checks.

The native warm-worker cut also exposed a reachability constraint: an ordinary
12-second idle poll can miss the original 10-second RPC lifetime. Preserve that
unreached recording. A separately named version-2 schedule restarts the real
reorg worker after B107 publication to begin actual recovery immediately; it
keeps the captured domain attempt and all production deadlines unchanged. A
missed restart cut still earns no guard coverage.

## 3. Weighted-Fork Fairness

Backlog: `BKL-075`.

Correct the external healing schedule that waits for rollback before publishing
the head advancement needed to mature remaining canonical checks. Preserve
immutable block history, real default RPC budgets and actual weighted endpoint
observations. Meet the declared freshness and reorg-window preconditions;
separate supported recovery from safe refusal beyond that window.

The original mixed A105/B106 ancestry is an observation, not proof of permanent
failure after fair healing. Advancing a tail alone is not evidence of repair.
Keep the original failed recording and add a fresh bounded history with explicit
producer, healing, eligibility, progress and canonical-state observations.

Acceptance: the fixture provides fair dependencies without requiring the desired
product outcome before releasing them. Its real production journey reaches a
meaningful convergence or refusal oracle, with all eligible durable work and
unreached guards accounted for. Application defects remain failed findings.

## 4. Final-Source Execution and CI

Backlog: `BKL-076`.

After the necessary harness/platform changes, freeze a concrete final source and
build a fresh full production guest from pinned inputs. Qualify eight-check M0,
then execute the complete discovered named corpus and both complete causal
campaigns on that image. Repeat the capture probe if its profile or image inputs
change. Report reached histories separately from executed case counts.

Reconcile milestone acceptance against actual evidence. Retain unimplemented
commit/ACK, uncertain-publication, authority and extension coverage explicitly;
do not label all scenario families complete merely because the declared corpus
ran. Do not fix unrelated production findings just to obtain green tests.

Acceptance: required local checks, final-source record/replay and full-disk
gates, complete case accounting, measured resource limits and retained failure
artifacts. Validate actual hosted matrix execution/artifact retrieval when
available within the authorized delivery workflow. A hosted access/publication
limit remains an explicit qualification gap rather than a local success claim.

## 5. Storage Optimizations and Independent Copies

Backlog: `BKL-077`.

Reassess optional coordinator reuse and hardlink exports with the new disk
headroom and current temporary-file policy. Compare a guarded rebuild with a
full-build logical production payload and dependency pins; whole ext4/qcow2
hash equality is not the appropriate equivalence criterion. Qualify the actual
image used. Keep a path only when its maintenance cost and benefit justify it.

Use an ordinary independent-copy export for one genuine failed counterexample,
restore its saved tool closure, relocate it and replay the original recording.
Check original pins and inode separation. Existing hardlink replay evidence is
valid for that explicit storage mode but is not independent backup evidence.

Acceptance: logical rebuild equivalence or a documented correction/removal;
one actual copy-based failed-counterexample reproduction with unchanged source
bytes and strict serial/disk equality. Exporting every failure again is not
required. Retain essential qualified evidence while treating disposable staging
as scratch, with explicit ownership rather than broad cleanup.

## Execution Order and Merge Review

Workstreams 1–3 can proceed independently with separate file ownership. Complete
their affected checks before freezing the shared guest for workstreams 4–5.
Commit logical chunks with GPG signing explicitly disabled; do not rebase away
historical source identities needed by retained recordings.

Before handoff, review the complete branch diff, domain/contract ownership,
configuration defaults, artifact sensitivity and failure classification. Run
the required focused and repository gates, document remaining product findings
and operational limitations, and distinguish merge readiness from a claim that
all product scenarios pass. Do not weaken the default CI gate or hide known
failures without an explicit, justified decision.

## Final Disposition

This section records the 2026-11-09 closure. The dated
[PR 15 follow-up](#pr-15-review-follow-up) below records subsequent corrections
and hosted evidence without changing those historical results.

Local execution closed on 2026-11-09 at executable source `0fc446b4`, with the
fresh full guest and frozen controller. All 26 declared cases actually recorded
and replayed, with exact serial and full-disk parity, no missing cases and no
retries or waivers. Sixteen pass their properties; ten remain failed. Seven of
twelve authored causal histories complete. The
[execution guide](08-simulation-workbench-execution.md#current-local-evidence)
owns the lane results, measured resources, diagnostic boundaries and retained
evidence index.

| Follow-up                      | Disposition                                | Evidence and remaining qualification                                                                                                                                                                                                                                                                                                                                                                          |
| ------------------------------ | ------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| BKL-073: native failures       | Partial; bounded diagnostic work completed | Actual registered-context capture and independent inspection pass; a real earlier fault instruction and invalid operand are located in V8. The corruption origin remains unknown. Real native controls reach selected journeys, but do not clear seven final-cohort SIGSEGV histories or qualify every engine path.                                                                                           |
| BKL-074: permanent oracle      | Done within the owning oracle scope        | Negative/positive supporting checks cover revision, source-time, numeric block floors and chain identity. All 158 observations of projected proof rows across checkpoints include actual fields; their block floors are null. A positive integer block-floor E2E journey remains unqualified. Cached coverage, witnessed retention, permitted terminal compatibility and fresh work have separate assertions. |
| BKL-075: fair weighted healing | Done within the authored version-2 history | Native control `control-2GEhlF` at source `0a75bb3c` and the final `0fc446b4` VM journey supply recovery dependencies and converge. Final VM strict replay passes; its permitted bid cancellation earns no retention, stale-rejection or current executable bid-proof credit. Version-1's unfair wait and original failure remain preserved.                                                                  |
| BKL-076: final source and CI   | Partial; complete local execution finished | Full-build M0/capture checks, all 26 strict pairs, actual history accounting, 429 supporting tests and artifact/resource review are complete. Default property gates remain red. GitHub publication and hosted matrix/artifact retrieval are blocked by unavailable SSH identity and missing OAuth workflow scope. No credentials were changed.                                                               |
| BKL-077: storage/copies        | Done within the tested local environment   | Actual final-image full/reuse inventories and pinned inputs match, with the documented metadata exception. Ordinary independent-copy relocation of a genuine failed counterexample reproduces the original failure with exact serial/disk equality and unchanged originals. Arbitrary-host portability remains unproved.                                                                                      |

The dedicated final VM stale cut is runtime-blocked before counter capture;
it earns zero restart or safety-cut credit. The separately authored native v2
control reaches exact old-lease refusal, newer pending work and a fresh proof
without changing the domain process or original deadline. Keep those claims
separate. A warm-v1 timing miss remains unreached and was not retried into a pass.

Two application findings have stable backlog identities: `BKL-078` for fresh
cross-fork validation/incorrect HTTP ask, and `BKL-079` for completed coverage
lost during maintenance. They remain Open; no production fix or expected-failure
promotion was added. Native exits remain runtime findings with unresolved origin.

The review found no additional concrete blocker in the production contract
extractions, artifact sensitivity or strict CI/accounting owners. The branch is
ready for review with these explicit limits; it is not unconditionally green
merge/release qualification. Remaining current-system scenario families and
unreached guards are listed with the milestone evidence in the execution guide.
Future P2P and multichain work, desktop packaging/rendering and host portability
retain their separate scopes. No push, PR, hosted success or merge is claimed.

## PR 15 Review Follow-up

Updated 2026-11-10, before publishing the review corrections. The independent
baseline review found concrete production, fixture and assertion defects. These
corrections preserve strict replay and failed-property reporting:

- Full order validation now uses one exact canonical block hash for scalar
  contract reads, status aggregates, individual fallback and native balances.
  Endpoint retries retain that selector. An endpoint that cannot serve the hash
  leaves validation unavailable for retry; it cannot turn uncertainty into an
  invalid order or silently substitute a numeric-height read. Existing
  allocation, retry and snapshot-lifetime rules remain in force.
- Offline order-table replacement retains every field of validation demand and
  completed proof belonging to surviving orders. Omitted orders retire their
  dependencies. The owning cutover transaction includes replacement, dependency
  cleanup and foreign-key verification, with enforcement restored on failure.
  This uses the private offline maintenance connection. Its whole-database
  foreign-key check is not bounded by the row-copy batch size. Historical lost
  proof is not reconstructed.
- Split-provider recovery consumes the actual `range_from`/`range_to` storage
  fields, with a real migrated row in the guard test. Untouched Seaport status
  is modeled as zero filled and zero size, separately from a fulfilled order.
  Signed full-validation compatibility checks exercise those wire values.
- Final HTTP convergence checks both canonical token holders, collection/detail
  asks and exact passive market-bid membership after the canonical order oracle.
  Collection requests explicitly use the public `token_status=all` contract;
  the API's legitimate default is listed tokens. The existing A104 activity
  check now requires the exact fixture fulfillment identity and economics,
  while the winning B history still rejects its orphan sale. Token-detail paths
  use the same shared route owner as the backend and frontend.
- Read-only observations now include SQLite collection repair intent separately
  from NATS messages. At the fixed endpoint, due eligible intent must settle.
  Future retries, immature ranges and inactive/changed-anchor intent remain
  explicit deferred evidence. This checks this single collection's scheduling
  boundary; it does not prove global scheduler fairness, retirement of every
  future retry or another RPC acquisition merely from a retained intent.
- The general proof oracle directly compares observed time/block requirements
  without invoking the production proof predicate. It still distinguishes
  retained cache, witnessed terminal state and fresh work. RPC HTTP finish
  receipts establish transport completion, with no claim of client consumption
  or a particular SQL fence.

The initial hosted setup correction, `0171408e`, resolves the installed
`mke2fs` path without changing the fixed engine environment. The workflow also
retains real tool-image build stdout/stderr, Dockerfile and capsule diagnostics.
The old 600-second build timeout has not recurred; its original cause remains
unknown. No timeout was increased and no host tooling or security configuration
was changed.

[Hosted run 42745082425](https://github.com/d347h-eth/artgod/actions/runs/42745082425)
completed both seven-case shards before these review fixes. Each passes all 429
supporting tests, the guest build and eight-check M0. All fourteen cases execute
with no missing entries; all fourteen reported serial/full-disk replay gates
pass. Nine application properties pass and five fail: bootstrap and weighted
fork have real worker SIGSEGV exits, both provider-disagreement cases retain
the coherence defect, and maintenance loses saved proof. These are executed
application failures, distinct from the earlier setup failures that left all
fourteen cases missing. The successful image-build diagnostics are retained,
including the actual Docker stderr, Dockerfile and capsule.

The first shard also supplies a genuine VM stale-v2 witness, `run-K3MM13`, at
synthetic merge source `b4269c05` over PR head `0171408e`. All six cut flags are
reached, the Domain process is unchanged, the Reorg process actually restarts,
and the original ten-second deadline remains. Snapshot-change refusal precedes
canonical acquisition and final settlement. This qualifies that exact history;
it does not clear other crashes, qualify uninterrupted Reorg timing, or prove
source-only generation fencing. GitHub's default PR checkout uses a synthetic
merge commit; compare checkout/build provenance and byte pins rather than
requiring its source SHA to equal the PR-head SHA.

Before the final collection-scope correction, full guest `guest-nS6vbO` at
`bd16df6c` passes all eight M0 checks and strict replay in `run-9NvboK`. Both
provider reproducers reach a new proof and correct `NoBalance` state; maintenance
retains saved coverage and reaches its later source/authority checks. All three
then fail the new HTTP membership assertion because the request used the default
listed scope. Those failed pairs remain immutable. The owning request correction
is `f25408af`; it keeps exact membership strict and adds a guard through the
actual collection HTTP mapper. Full-runtime acceptance of that corrected source
and its next hosted run remain pending at this dated update.

Supporting evidence is under `tmp/ci-fix-monitor-ehcqm0qw/`: all 503 actual
workbench tests pass with zero skips; the full indexer strict TypeScript graph
passes; 96 focused RPC/validation/durable/transport checks, 35 maintenance tests
and seven existing frontend API tests pass. Scoped formatting and documentation
verification pass. Sandboxed file-wrapper-only results are not counted as inner
test execution. The hosted shard audit admits report/serial/protocol byte pins;
it has not rerun the disk comparison locally. The corrected collection-scope
guest at `0308aa38`, `guest-94Hjnl`, also passes all eight substrate checks and
strict replay in `run-PrvSYR` (186.254 seconds). Final corrected-source application
and hosted acceptance remain pending at this update.

One downloaded genuine failed bootstrap bundle passes its 17-member byte/profile
audit, but initially stops at image admission on this Docker store: the recorded
config digest is not addressable after load, while the same archive's manifest
is addressable. The owning adapter now supports that concrete convention
difference by verifying the pinned archive, its single OCI manifest, recorded
config, uncompressed layer graph, platform and daemon descriptor/ordered RootFS.
It uses only the resulting immutable address, with no image search, implicit
load/pull, retagging, replacement build or recorded-file edit. Original v1 API
returns are preserved. Separate admission evidence is retained in container
artifacts and new run/replay reports, so existing exact report export also
preserves it. Unsupported graphs/address directions fail closed when the
original address is unavailable. This fixes a bounded adapter incompatibility;
it does not choose the deferred engine publication policy or promise arbitrary
Docker/host portability. The real original-log relocated replay and unchanged
member/inode bookend are in progress at this dated update.

The remaining review items need separate investigation or authored coverage:

- Attribute runtime crashes from a concrete first-fault observation before
  selecting an engine/runtime correction. A native non-crash or exact replay
  does not assign cause. Existing failures remain failed.
- Choose a published, digest-pinned complete engine closure and an explicit
  update policy. Saved per-run capsules are pinned, while fresh apt builds
  can drift. Registry/publication ownership is a separate decision; drift is
  not an established cause of the crashes.
- Add a production-created event-height obligation under lag/healing, then a
  source-only newer observation while a result is held. An inline maker proof
  may complete without a numeric floor being retained in the demand table.
  The required witness must follow the actual owning continuation.
- Add incomplete REST traversal versus newer stream input and late duplicates,
  source cancellation of the same orphan-filled order through rollback, and
  precisely observed accepted-input/SQL/ACK/outbox handoffs. Existing separate
  witnesses cannot be combined into those claims. A second collection sentinel
  and representative ERC1155 batch/reorg need external-model/oracle extensions;
  a nonzero conduit comes after those baseline cases.
- Complete HTTP activity-feed projection, pagination and daily offchain-history
  assertions separately. Exact storage fill execution/item/attribution and the
  fixture sale assertion do not establish a complete HTTP feed oracle.

No failed case is promoted to an expected pass. Native controls remain selected
diagnostics outside CI. Optimistic HTTP semantics, trading decision authority,
future chains/orderbooks and release qualification retain their existing scopes.

### Native Exit Attribution Follow-up

The final-source weighted provider run `run-QoSOWj` at `4b439b81` records a
Sync SIGSEGV after its initial checkpoint, before the provider and final HTTP
oracles. Its original record/replay pair remains a failed runtime case with
strict serial/disk parity. The old reporting map incorrectly called an earlier
unfinished HTTP placeholder a failed HTTP assertion.

Typed runtime exits now remove all unfinished non-runtime placeholders, preserve
every previously passed check and fail runtime execution. Ordinary oracle
assertions retain their original failure and are not reclassified from a
diagnostic SIGSEGV observation. A regression serializes the actual pending
HTTP/provider shape and requires both to remain `unreached`. All 504 supporting
tests pass with zero skips after this correction. Original reports and their
verdicts are not rewritten, and runtime failure does not become a passing case.

### Final Provider-Disagreement Sentinel

The provider-disagreement journeys now run the independent final market oracle
on both orders before HTTP derives visibility from stored status. Only the
listing may explicitly expect recoverable `NoBalance` with active source
evidence; the unaffected bid still requires active source, `Fillable` state and
valid retained proof with the existing revision/time/height checks. A matching
empty HTTP bid book cannot bless a corrupted terminal/source-inactive bid or
missing/stale proof. Fresh listing proof and exact final HTTP checks remain.

This closes an assertion gap rather than demonstrating another production
fault. All 509 supporting tests pass with zero skips after the added positive
and collateral-damage guards. The wholly coherent validation-B/persisted-A
scenario in SC-03 still needs its own authored history; a hash-pinned snapshot
does not establish consensus between components. No new recovery or terminal
reactivation policy is implied.

### Measured Slow Tool-image Acquisition

The first shard of run `42759998152` stops during tool-image construction at
the existing 600-second limit. Retained Docker stderr establishes slow Ubuntu
acquisition in this run: package indexes take 261 seconds for 33.8 MB, followed
by a normal 41-package/24.5 MB installation still downloading package eight at
587.6 seconds. The build is then cancelled by the owner. No application,
compiler or package-resolution failure is shown. This evidence does not explain
the original earlier timeout retrospectively. The blocked ledger correctly
leaves all seven assigned cases missing/unreached; neither supporting checks
nor M0 ran on that shard.

Only Docker tool-image construction now receives a bounded thirty-minute
budget. Save/load/inspection limits, VM and application deadlines, and the
180-minute CI job budget remain unchanged. No mirror, retry, image-selection,
registry or caching policy is changed. Timeout guards retain exact diagnostics
and refuse to consume a partial image identity or publish a capsule. All 510
supporting tests pass with zero skips. This is measured startup headroom, not
a guarantee of mirror availability or application correctness. A stable
published complete engine closure remains the separate deferred policy.
