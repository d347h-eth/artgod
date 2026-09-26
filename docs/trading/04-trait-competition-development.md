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

Extra selectors match single-trait offers only, as confirmed by the user.
Selecting a key/value does not include multi-trait offers containing that pair;
selecting a whole key includes standalone trait offers for all its values.

## Iterations and Acceptance Evidence

1. [x] Read project guidance and trace the ordinary trait-job path; create a
       feature worktree from local `main` and record this plan.
2. [x] Implement inclusive default competition in an owning domain policy and
       both snapshot and fallback discovery. Verify single traits, full matches,
       subsets, unrelated and narrower combinations, duplicate criteria, and
       unchanged collection-only behavior.
3. [x] Add validated extra selectors to the job contract, HTTP mutation/view,
       SQLite migration/repository, runtime loading and declaration reconciliation.
       Verify upgrade, round trip, omission versus explicit clearing, atomic command
       creation, target identity, and price-tier reapply preservation.
4. [x] Apply extra selectors to competitor assessment. Verify wildcard and exact
       matches, deduplication, unchanged placement payloads, exact own-order
       recovery/cancellation, and price-ceiling enforcement in the bidder pipeline.
5. [x] Add the compact trait-job editor. Verify create, load, modify, remove,
       reset, validation/recovery and restricted states using unit tests and the
       maintained deterministic Playwright harness. Inspect rendered artifacts.
6. [x] Update current-state documentation and OpenAPI; run relevant owner suites,
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
- Ordinary trait jobs are collection targets with nonempty traits. At baseline,
  snapshot and fallback discovery required exact trait equality. Own-order
  management independently requires exact equality and must retain that rule.
- Worktree dependencies installed with the immutable lockfile and lifecycle
  scripts disabled.
- Iteration 2: domain policy and OpenSea adapter suites pass, 27 tests. Snapshot
  selection includes matching single traits; fallback paginates all offer scopes
  and rejects repeated cursors or failed pages. Exact own-order matching remains
  separate. OpenSea documents [all offers](https://docs.opensea.io/reference/list_offers_collection_all)
  separately from [collection offers](https://docs.opensea.io/reference/get_offers_collection).
- Iterations 3–4: complete backend suite passes (383 tests), complete trading
  suite passes (337 tests), and the shared selector suite passes (2 tests).
  Shared declarations, backend and trading TypeScript checks pass. Migration
  replay preserves an existing declaration; command failure rolls back edits;
  omission and price-only reapply preserve extras; explicit clearing works.
  Snapshot/fallback selection agree; placement contains only target traits;
  the bidder cancels only the exact own target and respects the price ceiling.
- Iteration 5: the complete frontend unit suite passes (452 tests), bidding
  automation passes (42 browser tests), and public-mode guards pass (4 browser
  tests). The editor covers create, lookup, modify, reset, explicit clearing,
  incomplete input, pending save, failed save/retry, and trait-trust read-only
  state. Rendered empty, editable, invalid, saved, saving, failure and read-only
  states were inspected at desktop and narrow viewports. Screenshot dimensions
  are 1920 x 1080 and 1082 x 2202 pixels respectively. Copy review retained only
  labels, selector controls and actionable validation.
- Iteration 6: frontend checking reports zero errors and 86 warnings. Userland
  and desktop runtime builds pass. Documentation validation and Prettier checks
  for changed TypeScript, JSON, Markdown and YAML pass, as does `git diff --check`.
  The installed formatter has no Svelte parser; Svelte files were reviewed for
  formatting and checked by the compiler. Work is committed in unsigned logical
  chunks; no native package, live session or remote CI verification is claimed.

## Final Requirement Audit

| Requirement                               | Implementation and verification                                                                                                                                                                                                                                                                    |
| ----------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Inclusive default for ordinary trait jobs | `matchesTraitCompetition` accepts every nonempty subset of the exact target. Domain and OpenSea adapter tests cover singles, pairs, larger subsets, unrelated/narrower combinations and duplicate criteria. Collection-wide offers remain included.                                                |
| Extra exact values and whole keys         | Shared normalization, persisted config and runtime policy support both forms. Extras match standalone single-trait offers only. Tests exclude multi-trait offers containing an extra and cover whole keys, duplicate selectors and wildcard precedence.                                            |
| Competition-only scope                    | Placement tests assert only declared target traits reach OpenSea. Bidder tests retain exact own-order management, enforce the ceiling and reject a satisfied declaration with different extras. Target identity, quantity and authorization enforcement remain separate.                           |
| Compatible public-alpha upgrade           | Migration replay preserves the existing declaration and initializes empty extras. Repository tests cover round trip, omitted fields, explicit clearing, price-tier reapply, revision updates and transaction rollback when command insertion fails. Runtime-source tests load the saved selectors. |
| Compact per-job management                | Browser tests cover entry, saved-job lookup, create/modify, reset/removal, validation, pending/failing save with retry and trait-trust restrictions. Public-mode tests keep bidding controls unavailable. Rendered states and changed copy were reviewed.                                          |
| Keep legacy jobs separate                 | The new field belongs to ordinary collection targets with traits. Existing legacy competitive-trait tests pass without changing that target kind or its placement behavior.                                                                                                                        |
| Avoid extra marketplace fanout            | Snapshot and all-offers fallback use the same policy. Tests reject incomplete fallback pagination and assert no trait enumeration or per-selector requests.                                                                                                                                        |

Final verification commands (test scratch files were directed to the worktree's
`tmp/` directory with `TMPDIR`):

- `yarn workspace @artgod/backend test` — 383 tests pass.
- `yarn workspace @artgod/trading test` — 337 tests pass.
- `yarn workspace @artgod/frontend test` — 452 tests pass.
- `yarn workspace @artgod/shared test trading/trait-competition.test.ts` — 2 tests pass.
- `yarn test:bidding:automation` — 42 browser tests pass.
- `yarn test:bidding:automation:public` — 4 browser tests pass.
- `yarn exec tsc -b shared --pretty false`,
  `yarn exec tsc --noEmit -p backend/tsconfig.json`, and
  `yarn exec tsc --noEmit -p trading/tsconfig.json` — pass.
- `yarn workspace @artgod/frontend check`, `yarn build:userland`, and
  `yarn build:desktop-runtime` — pass with the warning boundary above.
- `yarn check:docs` — 75 Markdown files pass validation.
