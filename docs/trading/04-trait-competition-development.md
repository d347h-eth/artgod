# Trait Bidding Competition Development

This plan tracks the requested extension to ordinary trait-scoped collection
jobs. Current behavior belongs in [bidding capabilities](02-bidding-automation-capabilities.md)
and [market data](03-market-data-and-scaling.md). Overall status is tracked in
the [unified backlog](../planning/01-unified-backlog.md#trait-bidding-competition).

## Intended Behavior

- A trait job considers collection-wide offers and every nonempty subset of its
  target traits, including each individual trait and the full target.
- Each trait job can persist extra competition selectors: an exact key/value or
  an entire key, covering every value observed in the authoritative snapshot.
- Extra selectors affect competitor assessment only. Offer submission, target
  identity, quantity, price limits, own-order recovery, and cancellation retain
  the exact declared target.
- Extra selectors are additive; an empty set retains the inclusive default.
  Changes update the existing job and durable command outbox, without changing
  its identity. Omitted fields from older clients preserve saved extras.
- The new behavior extends ordinary trait jobs, without repurposing legacy
  competitive-trait jobs or adding per-selector marketplace polling.
- Existing installations upgrade through an append-only migration. Existing
  jobs receive no extras; their default competition becomes inclusive.
- The shared bidding panel provides compact add/remove controls for per-job
  selectors, and preserves edits, reset, existing-job lookup, price-tier reapply,
  and read-only/public restrictions.

Extra selectors provisionally match any trait offer containing the selected
key/value or key. The requested clarification will settle whether this includes
multi-trait offers before that behavior is finalized.

## Iterations and Acceptance Evidence

1. [x] Read project guidance and trace the ordinary trait-job path; create a
       feature worktree from local `main` and record this plan.
2. [ ] Implement inclusive default competition in an owning domain policy and
       both snapshot and fallback discovery. Verify single traits, full matches,
       subsets, unrelated and narrower combinations, duplicate criteria, and
       unchanged collection-only behavior.
3. [ ] Add validated extra selectors to the job contract, HTTP mutation/view,
       SQLite migration/repository, runtime loading and declaration reconciliation.
       Verify upgrade, round trip, omission versus explicit clearing, atomic command
       creation, target identity, and price-tier reapply preservation.
4. [ ] Apply extra selectors to competitor assessment. Verify wildcard and exact
       matches, deduplication, unchanged placement payloads, exact own-order
       recovery/cancellation, and price-ceiling enforcement in the bidder pipeline.
5. [ ] Add the compact trait-job editor. Verify create, load, modify, remove,
       reset, validation/recovery and restricted states using unit tests and the
       maintained deterministic Playwright harness. Inspect rendered artifacts.
6. [ ] Update current-state documentation and OpenAPI; run relevant owner suites,
       frontend checks/build, documentation validation and changed-file formatting.
       Audit every requirement against current evidence and commit logical chunks
       with `git commit --no-gpg-sign`.

## Verification Boundary

All database checks use disposable fixtures. Browser checks use the maintained
fixture harness; marketplace responses and orders are synthetic. This work does
not authorize live bids, live data mutation, runtime restarts, deployment, or
release. Local checks are not remote CI or live OpenSea evidence.

## Progress and Results

- Baseline: local `main` at `b7a7f7fd`; new branch
  `feature/trait-bidding-competition`.
- Ordinary trait jobs are collection targets with nonempty traits. Snapshot and
  fallback discovery currently require exact trait equality. Own-order
  management independently requires exact equality and must retain that rule.
- Worktree dependencies installed with the immutable lockfile and lifecycle
  scripts disabled.
