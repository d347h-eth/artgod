# Trait Bidding Competition

This document owns competition matching and versioned `extra targets` presets
for ordinary trait-scoped collection jobs. These jobs submit offers for a
concrete AND combination of traits. Presets extend the bids considered when
choosing a price; they do not extend the submitted offer's target.

[Bidding Automation Capabilities](02-bidding-automation-capabilities.md) owns
the user workflow and API inventory. [Bidding Runtime and Jobs](01-bidding-runtime-and-jobs.md)
owns declaration, command, and wallet boundaries. [Market Data and Scaling](03-market-data-and-scaling.md)
owns snapshot authority, fallback, freshness, and processing costs.

## Competition Rules

Every ordinary trait job considers:

- collection-wide offers;
- trait offers whose nonempty criteria are a subset of the job's concrete
  target, including the exact target;
- standalone single-trait offers matching any selected extra target.

Subset matching applies even with `none` selected. A `Mode=Terrain` job includes
collection-wide bids and standalone `Mode=Terrain` bids. A
`Mode=Terrain + Zone=Kairo` job also includes standalone `Zone=Kairo` bids and
bids for the exact pair. Offers requiring an additional trait, or a different
value, are excluded unless they qualify independently as a standalone extra.
Explicit-token offers are excluded from this trait-job comparison.

### Extra Target Selectors

An exact selector such as `{ "type": "Biome", "value": "42" }` includes
standalone `Biome=42` bids. A whole-key selector such as `{ "type": "Biome" }`
includes standalone bids for every Biome value observed in the authoritative
market data. It does not enumerate metadata values or issue a request per value.

Multiple extras are independent alternatives: matching any selector is enough.
They cannot express a two-trait AND target. Selecting `Biome=42` and
`Chroma=Fog` includes each standalone bucket, but not a bid requiring both
together. The same rule applies whether the main job targets one or two traits.
Repeated copies of the same criterion still count as a standalone trait;
different key/value criteria do not.

For a `Mode=Terrain + Zone=Kairo` job:

| Observed offer target                  | With `none` | With extra `Biome=42` |
| -------------------------------------- | ----------- | --------------------- |
| Collection-wide                        | Included    | Included              |
| `Mode=Terrain`                         | Included    | Included              |
| `Zone=Kairo`                           | Included    | Included              |
| `Mode=Terrain + Zone=Kairo`            | Included    | Included              |
| `Biome=42`                             | Excluded    | Included              |
| `Biome=42 + Chroma=Fog`                | Excluded    | Excluded              |
| `Mode=Terrain + Zone=Elsewhere`        | Excluded    | Excluded              |
| `Mode=Terrain + Zone=Kairo + Biome=42` | Excluded    | Excluded              |

Extras are additive. Clearing a preset restores inclusive subset competition;
it does not restore exact-target-only competition.

## Source Patterns and Validation

A preset's `source target` determines which job targets can select it. The
source contains one or two unique trait keys. Each key specifies either an
exact value or any value. Its complete key combination must match the job:
source patterns do not apply to jobs with fewer or additional target keys.

| Preset source            | Concrete job target           | Applicable |
| ------------------------ | ----------------------------- | ---------- |
| `Zone=any`               | `Zone=Shahra`                 | Yes        |
| `Zone=any`               | `Zone=Tetsu`                  | Yes        |
| `Zone=any`               | `Mode=Terrain + Zone=Shahra`  | No         |
| `Mode=any + Zone=Shahra` | `Mode=Terrain + Zone=Shahra`  | Yes        |
| `Mode=any + Zone=Shahra` | `Mode=Daydream + Zone=Shahra` | Yes        |
| `Mode=any + Zone=Shahra` | `Mode=Terrain`                | No         |
| `Mode=any + Zone=Shahra` | `Mode=Terrain + Zone=Tetsu`   | No         |

Wildcards reduce the number of presets needed for a key's values. The job still
declares concrete values, and OpenSea receives those concrete criteria.

Source and extra selectors share the `{type, value?}` representation. Omitting
`value` encodes a wildcard; an explicit string `"any"` is a literal metadata
value. Dropdowns distinguish `any (all)` from quoted metadata values. Compact
labels show `Key=any` for wildcards and `Key="any"` for that literal value.

The shared domain validates and canonicalizes selectors:

- source patterns require one or two distinct keys; repeated source keys are
  rejected;
- presets require at least one extra and accept at most 64 entries;
- keys and explicit values must be nonempty strings and are trimmed;
- extras are sorted and deduplicated; a whole-key selector subsumes exact
  selectors for the same key;
- concrete job targets require explicit values and are canonicalized
  independently of preset patterns.

Explicit source values reuse the marketplace-supported job-target check.
Source wildcards and extra selectors use the unfiltered collection trait
catalog. A wildcard source does not bypass validation of the actual concrete
target when a job is created or updated.

## Immutable Versions and Job Updates

Presets belong to a chain and collection inventory. Creation stores revision
one; editing inserts a new immutable version and advances the inventory's
current revision. Edit and archive requests require `expectedRevision` so a
stale editor cannot overwrite or archive a newer definition.

Each job references one selected version. Editing a preset leaves existing
job references, revisions, and commands unchanged. Archiving removes the preset
from new selections while retaining its versions for jobs that already use them.
A saved older or archived version remains readable and selectable for its
existing job.

To adopt a newer version, select it for the job and confirm `modify`. To remove
extras, select `none` and confirm `modify`. An explicit selection change updates
the existing declaration and durable command outbox atomically; target identity
and job ID remain the same. The bot reloads the declaration through normal
command reconciliation.

The trait-job mutation field is `competitionPresetVersionId`:

| Mutation value         | Effect                                                                                        |
| ---------------------- | --------------------------------------------------------------------------------------------- |
| Omitted                | Preserve the existing reference; a new job starts with none.                                  |
| `null`                 | Clear the reference.                                                                          |
| A different version ID | Select a current, unarchived version for this chain, collection, and complete target pattern. |
| The saved version ID   | Retain that version, including after a preset edit or archive.                                |

Pricing-only edits and price-tier reapply preserve the selected version.
The panel tracks preset edits separately from price edits: a delayed target
lookup hydrates an untouched selection without replacing edited prices, while
an explicit selection or clear remains the user's choice. Unchanged selections
are omitted from save requests.

## Persistence and Runtime Boundaries

Migration [`062_trait_competition_presets.sql`](../../database/migrations/062_trait_competition_presets.sql)
creates:

- `trading_bidding_competition_presets`, the collection inventory with current
  revision and archive state;
- `trading_bidding_competition_preset_versions`, immutable source and extra
  selector JSON, unique by preset and revision;
- nullable `trading_bidding_job_specs.competition_preset_version_id`, a foreign
  key to the selected version, with an index for referenced versions.

The backend and bot use the same joined job projection to resolve selected
versions. They validate persisted scope and source applicability rather than
silently ignoring a broken reference. Null references resolve to no extras.
There is no additional database query per loaded job or marketplace request
per selector. Version decoding still occurs for each referencing job.

Competition matching belongs to
[`matchesTraitCompetition`](../../trading/src/domain/market/strategy/trait-competition.ts).
Both shared-snapshot selection and missing-snapshot all-offers fallback call
that policy. The fallback must complete pagination; a failed page or repeated
cursor rejects the read. Freshness, stream scheduling, and background polling
retain their existing policies.

Extras affect competitor assessment only. Offer submission, target lookup
identity, quantity, pricing caps, authorization, and exact own-order recovery
and cancellation use the concrete declared target. Extras never enter the
OpenSea placement request. Token-scoped jobs, collection-wide jobs with no
traits, and the separate legacy competitive-trait job kind retain their existing
competition paths. Inclusive subset matching broadens ordinary multi-trait
competition even when no preset is selected.

### Upgrade and Development-Schema Rollback

Normal migration replay adds the nullable reference to existing declarations.
Existing jobs keep their targets, pricing, revisions, and orders, with no preset
selected. Ordinary trait jobs use inclusive subset competition after the upgrade.

Only a local development database that applied the removed, unreleased
`056_trait_bidding_competition.sql` needs the following manual rollback before
normal migration replay. Stop the application and bot before running it. The
rollback discards the former per-job extras JSON; it retains job targets,
pricing, revisions, and orders. Do not apply it to a database without that old
column and migration record.

```sql
BEGIN IMMEDIATE;
ALTER TABLE trading_bidding_job_specs
  DROP COLUMN extra_competition_traits_json;
DELETE FROM migrations
  WHERE name = '056_trait_bidding_competition.sql';
COMMIT;
```

The removed migration is not replayed. Migration `062_trait_competition_presets.sql`
creates the inventory and job reference; old per-job extras are not imported.

## Verification and Current Limits

Behavior coverage lives in:

- [`shared/trading/trait-competition.test.ts`](../../shared/trading/trait-competition.test.ts)
  for selectors, wildcard applicability, literal values, and version selection;
- [`trading/src/domain/market/strategy/trait-competition.test.ts`](../../trading/src/domain/market/strategy/trait-competition.test.ts)
  and OpenSea bidding-service tests for inclusive subsets, standalone extras,
  snapshot/fallback parity, and exact placement and own-order boundaries;
- backend preset use-case, HTTP adapter, and SQLite job-repository tests for
  scope, immutable references, stale edits, preservation, transactional commands,
  migration replay, and rollback;
- [`frontend/e2e/bidding-automation.spec.ts`](../../frontend/e2e/bidding-automation.spec.ts)
  and public-mode tests for management, selection, pinned/archived versions,
  delayed lookup, recovery, restrictions, and desktop/narrow controls.

The owning suite commands are maintained in
[Verification Coverage](02-bidding-automation-capabilities.md#verification-coverage).
Fixture tests establish local behavior; they do not establish live OpenSea,
native WebView, remote CI, or load-performance results.

Current limits:

- Extra targets cannot require a pair of different key/value criteria together.
- Preset sources contain at most two keys, and extras are bounded at 64 entries.
- Jobs adopt changed presets individually; a staged bulk reapply flow is not
  implemented.
- Historical versions are retained without automatic cleanup.
- Full per-job snapshot scans, repeated version decoding, and offer deduplication
  remain scaling costs. [Market Data and Scaling](03-market-data-and-scaling.md#trait-competition-processing)
  describes them; no negligible-overhead claim is established by functional tests.

The [unified backlog](../planning/01-unified-backlog.md#trait-bidding-competition)
owns feature status and priority.
