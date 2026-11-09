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
The baseline projection omits `required_at` and `minimum_block`; the generic
oracle currently checks only positive validation time, settled demand and chain
revision. Use the owning validation-demand contract, preserve terminal-source
exceptions and existing optimistic visibility, and keep chain truth independent
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
