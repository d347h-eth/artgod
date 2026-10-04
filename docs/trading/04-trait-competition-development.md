# Trait Bidding Competition Development

This plan tracks the requested extension to ordinary trait-scoped collection
jobs. Current behavior belongs in [bidding capabilities](02-bidding-automation-capabilities.md)
and [market data](03-market-data-and-scaling.md). Overall status is tracked in
the [unified backlog](../planning/01-unified-backlog.md#trait-bidding-competition).

## Intended Behavior

- A trait job considers collection-wide offers and every nonempty subset of its
  target traits, including each individual trait and the full target.
- Collection presets pair one or two source trait keys, each with an exact value
  or any value, with extra selectors. Jobs reference immutable preset versions;
  edits never change existing jobs implicitly.
- Extra selectors affect competitor assessment only. Offer submission, target
  identity, quantity, price limits, own-order recovery, and cancellation retain
  the exact declared target.
- Extra selectors are additive; an empty set retains the inclusive default.
  Changes update the existing job and durable command outbox, without changing
  its identity. Omitted reference fields preserve the selected version; null clears it.
- The new behavior extends ordinary trait jobs, without repurposing legacy
  competitive-trait jobs or adding per-selector marketplace polling.
- Installations based on main upgrade through a new migration. Existing jobs
  receive no extras; their default competition becomes inclusive. The unpublished
  per-job migration is replaced; its one local installation requires the manual
  rollback documented below.
- A collection section beside tiers provides structured preset creation/editing.
  The shared bidding panel selects a matching preset with compact buttons and
  defaults to none. Reset, lookup, price-tier reapply and restrictions are retained.

Extra selectors match single-trait offers only, as confirmed by the user.
Selecting a key/value does not include multi-trait offers containing that pair;
selecting a whole key includes standalone trait offers for all its values.

## Initial Iterations and Acceptance Evidence (Historical)

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

## Initial Progress and Results (Historical)

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

## Initial Requirement Audit (Historical)

| Requirement                               | Implementation and verification                                                                                                                                                                                                                                                                    |
| ----------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Inclusive default for ordinary trait jobs | `matchesTraitCompetition` accepts every nonempty subset of the exact target. Domain and OpenSea adapter tests cover singles, pairs, larger subsets, unrelated/narrower combinations and duplicate criteria. Collection-wide offers remain included.                                                |
| Extra exact values and whole keys         | Shared normalization, persisted config and runtime policy support both forms. Extras match standalone single-trait offers only. Tests exclude multi-trait offers containing an extra and cover whole keys, duplicate selectors and wildcard precedence.                                            |
| Competition-only scope                    | Placement tests assert only declared target traits reach OpenSea. Bidder tests retain exact own-order management, enforce the ceiling and reject a satisfied declaration with different extras. Target identity, quantity and authorization enforcement remain separate.                           |
| Compatible public-alpha upgrade           | Migration replay preserves the existing declaration and initializes empty extras. Repository tests cover round trip, omitted fields, explicit clearing, price-tier reapply, revision updates and transaction rollback when command insertion fails. Runtime-source tests load the saved selectors. |
| Compact per-job management                | Browser tests cover entry, saved-job lookup, create/modify, reset/removal, validation, pending/failing save with retry and trait-trust restrictions. Public-mode tests keep bidding controls unavailable. Rendered states and changed copy were reviewed.                                          |
| Keep legacy jobs separate                 | The new field belongs to ordinary collection targets with traits. Existing legacy competitive-trait tests pass without changing that target kind or its placement behavior.                                                                                                                        |
| Avoid extra marketplace fanout            | Snapshot and all-offers fallback use the same policy. Tests reject incomplete fallback pagination and assert no trait enumeration or per-selector requests.                                                                                                                                        |

Initial verification commands (test scratch files were directed to the worktree's
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

## Preset Revision (2026-10-04)

The original per-job text editor is superseded by a collection inventory. Its
historical verification above describes the initial implementation. Current
jobs reference one immutable version, while inventory definitions own target
criteria and extras. A preset edit increments its revision without changing job
revisions, references or outbox commands. Explicit job selection changes retain
the existing transactional declaration/outbox flow. Archived versions remain
readable to referenced jobs; new selection rejects archived, stale, foreign
collection or mismatched target definitions. Updates use expected revisions to
reject stale editors. Bulk reapply remains future work; individual jobs can
explicitly select the current version today.

The shared domain owns source-selector and concrete job-target validation.
Explicit source values reuse job creation's marketplace eligibility check;
source wildcards and extra choices use the unfiltered collection trait catalog.
Backend reads and the bot share a joined SQLite projection of the selected
version, without an additional query per loaded job. Competition matching and
OpenSea submission/own-order policy remain unchanged.

The `extra targets` section is available beside tiers only in Offers' traits
view. Source and extra choices use exact/any dropdowns. The trait-job panel,
including jobs opened from other collection views, lists only matching presets, defaults to none,
and retains a saved older version as an explicit choice. Labels wrap within the
small panel. Loading, failed writes, reset, retry and trait-trust restrictions
retain their established behavior. Scope changes ignore late responses from
the previous collection.

### Initial Preset Verification (Before UI Corrections)

- Backend suite: 581 tests pass, including protected HTTP routes, versioned
  persistence, wrong scope/target and stale-version rejection, price-only
  preservation, outbox rollback, and the manual migration replacement.
- Shared suite: 376 tests pass. Frontend unit suite: 566 tests pass.
- `yarn test:bidding:strategy --maxWorkers=3`: 404 tests pass and all per-file
  coverage thresholds pass. Runtime source loading retains the selected version
  when newer definitions exist; strategy and exact placement policy stay covered.
- Maintained bidding browser suite: 92 tests pass across desktop and Pixel 7.
  Public-mode suite: 8 tests pass. The eight preset checks pass again after the
  final editor spacing adjustment. Coverage includes create, lookup, matching
  options, none/reset/clearing, explicit version upgrades, archive retention,
  pending writes, failed load/save with retry, and trait-trust restrictions.
- Shared declaration build, backend/trading TypeScript checks, Userland and
  desktop runtime builds pass. Svelte checking reports zero errors and 87
  warnings in 19 files. No native package or live-runtime check is claimed.
- Documentation validation passes for 77 Markdown files and checks OpenAPI
  route parity, references, nullable schemas and mutation security. Changed
  TypeScript, JSON, Markdown, YAML and CSS formatting and `git diff --check` pass.
  The installed formatter has no Svelte parser; component scripts/styles are
  formatted with its TypeScript/CSS parsers and markup is reviewed manually.
- Rendered inventory and bidding-panel states were inspected in reading order
  at desktop and narrow viewports, including older/archived references, loading
  failure, pending saves, write recovery and read-only restrictions. Viewport
  captures are 1920 x 1080 and 1082 x 2202 pixels; full-page editor captures also
  include the footer below the fold. Artifacts are retained under worktree
  `tmp/competition-presets-browser-handoff/` and the complete suite directory.
- UI copy review retains compact labels, choices, versions and actionable
  errors. The superseded plaintext editor and its single-trait heading are gone.
  The separate performance handoff remains uncommitted and now describes the
  versioned storage costs and additional measurement scenarios.

### UI Alignment and Source Wildcards (2026-10-04)

The editor now uses the existing price-tier panel, table, label/control grid,
and action families. Reset is pink; create/modify and archive use the existing
armed confirmation styles, with confirmation cleared on outside pointer/focus
events. The preset selector in the bidding panel uses the same secondary-tab
family as pricing. User-facing labels use `extra targets`; internal identifiers,
API routes and storage names retain their existing competition vocabulary.

Sources contain at most two distinct keys. A source's keys must equal the whole
job target's key combination, and each explicit source value must match the
job's concrete value. For example, `Mode=any + Zone=Shahra` matches both
`Mode=Terrain + Zone=Shahra` and `Mode=Daydream + Zone=Shahra`. It does not
match `Mode=Terrain` or a target with an additional third key. A one-key source
such as `Zone=any` covers all concrete single-key Zone jobs.

Wildcard dropdown options display `any (all)` outside the `values` group and
use the existing orange active-state style. Actual metadata values named `any`
remain explicit values, appear quoted, and have distinct option values. Source
and extra summaries retain `Key=any` for wildcards and `Key="any"` for literal
metadata. Jobs still submit concrete traits; wildcards describe applicability
of a preset only. Extra selectors still count standalone single-trait bids.

No additional migration is needed: the immutable preset version already stores
selector JSON, and an omitted source value encodes the wildcard. Referenced
versions remain pinned. Wildcards are compared directly without expanding
source values or adding polling, job enumeration, or per-job database reads.

Verification for this correction:

- Shared trait-selector domain: 6 tests pass. Backend preset use-case and job
  repository checks: 19 tests pass. Backend HTTP/API file: 98 tests pass.
  Runtime job-source adapter: 4 tests pass. These cover wildcard round trips,
  concrete job targets, complete key combinations, two-key/repeated-key
  validation, literal metadata `any`, and preservation of pinned versions.
- Frontend unit suite: 566 tests pass. The complete bidding browser suite:
  96 tests pass across desktop and Pixel 7, including the new source-wildcard
  and traits-only entry cases and existing tier/bidding workflows. Public-mode
  suite: 8 tests pass. Strategy suite and coverage gate: 404 tests pass.
- Shared declarations, backend/trading TypeScript checks, Userland and desktop
  runtime builds pass. Svelte checking reports zero errors and 87 warnings in
  19 files. These are local fixture/build checks, with no live orders or native
  WebView verification.
- Reviewed the editor and bidding-panel renders in reading order, including
  blank/populated controls, literal/wildcard choices, source pairs, pending
  saves, load/write recovery, retained old/archived versions, read-only state,
  and the existing price-tier form. Viewport images are 1920 x 1080 and
  1082 x 2202 pixels; source-wildcard and literal-value full-page Pixel images
  are 1082 x 3095 and 1082 x 2990. Larger full-page captures retain the footer
  and surrounding collection context. Artifacts are retained in worktree
  `tmp/extra-targets-ui-review/browser-final/` and `browser-public/`.
- UI copy review retains compact labels, explicit choices and recovery actions.
  Documentation validation passes for 77 Markdown files, including OpenAPI
  checks. Changed-file formatting and `git diff --check` pass; Svelte markup
  is reviewed manually with scripts formatted using the TypeScript parser.
- The separate uncommitted performance handoff records the reduced inventory
  cardinality and unchanged per-job hydration/matching costs, plus the related
  harness scenarios. No performance measurement is claimed by these checks.

### Local Migration Replacement

The user confirmed the superseded migration exists only in their local database.
Stop the application and bot before running the following manually. This removes
saved per-job extras; job targets, pricing, revisions and orders are retained.
The agent runs this SQL only on disposable verification databases.

```sql
BEGIN IMMEDIATE;
ALTER TABLE trading_bidding_job_specs
  DROP COLUMN extra_competition_traits_json;
DELETE FROM migrations
  WHERE name = '056_trait_bidding_competition.sql';
COMMIT;
```

After switching to this implementation, normal migration replay applies
`062_trait_competition_presets.sql`. The old migration file is removed, so its
JSON column is not recreated. Existing jobs start with no preset selected.
