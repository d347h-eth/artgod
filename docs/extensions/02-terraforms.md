# Terraforms Extension

Terraforms is the first bundled collection extension. It demonstrates how one
collection can own chain events, enrichment, media choices, trait presentation,
activity rendering, and a collection page without placing Terraforms literals
or rules in generic indexer, backend, or frontend modules.

## Identity and Installation

`shared/extensions/terraforms.ts` owns the extension key, Ethereum mainnet
contract, deployment block, collection/OpenSea slug, ERC-721 standard, token
scope, contract addresses, renderer versions, event vocabulary, trait keys,
media variants, and page reference.

Bootstrap requests resolve the embedded match from chain, contract, standard,
and approved token scope. The requested extension key is persisted in the run
plan; installation is upserted after the anchor succeeds and before canonical
metadata fan-out can create extension work. Generic code asks the embedded
registry for a match and never branches on Terraforms values.

## Indexed State

The Terraforms indexer adapter adds watch specs for:

- main-contract `Daydreaming` and `Terraformed` events;
- V2 tokenURI `AttunementSet` events;
- V2 Beacon `ParcelModified` events.

Watch outputs normalize to the generic metadata refresh contract. Immutable
extension event facts are stored separately and projected into activity rows;
the sync hook does not gain arbitrary stateful domain authority.

After canonical metadata writes, the extension artifact worker reconstructs V2
renderer inputs and stores extension-owned artifacts and normalized traits. For
minted tokens it uses normalized current attributes and collection-owned chain
reads rather than parsing raw metadata JSON as runtime state.

Current extension traits include:

- `Minted`, including synthetic unminted placements;
- `Mode` and `Seed`;
- `Seed Class` (`X-Seed`, `Y-Seed`, or `Godmode` when applicable);
- `Seasons = Season 0` when current Beacon state proves the first antenna-on
  mutation predates the extension-owned cutoff.

The extension also derives V2 artifacts for settled but unminted placements.
Those rows use extension-synthetic token identities and never create canonical
`token_metadata`. When the real token appears, the real artifact/trait write and
synthetic retirement marker are atomic; delayed synthetic retries then no-op.

Canonical metadata completion and collection liveness do not wait for extension
artifacts. Their durable task leases, retries, and terminal state remain a
separate eventual side lane.

## Media and Customization

Snapshot mode can expose:

- extension `V2 artifact`;
- explicit `V2 lost terrain` for eligible canonical tokens;
- canonical V2/V0 approximations where normalized version evidence permits.

Live mode performs request-time renderer reads for V2, V1, or V0. It does not
reuse snapshot artifacts, preview caches, or the artifact worker's Daydream
canvas override. Failure stays visible and retryable rather than falling back
silently.

The collection preference `prefer V2` chooses a default but never
auto-selects lost terrain. `media_mode`, `media_preference`, and token-local
`media_variant` keep source, preference, and exact choice distinct.

Terraforms also supplies default collection customization for range/set trait
presentation and compact token-card/activity trait summary templates. Users can
select user-owned or extension-owned customization per feature. The backend
renders the constrained template so token cards and activity includes share one
result.

## Activity Presentation

The extension owns its activity event labels, grouping, previews, and artifact
versus network render modes. Event preview is a separate extension contract from
token media preview even though both use the shared sandboxed modal frame.

Raw extension event facts remain immutable. User-facing activity can group or
coalesce presentation without changing source-event identity.

## Hypercastle Page

The extension contributes `hypercastle` through the generic collection-page
registry. Standard mode uses:

```text
/:chain_ref/:collection_ref/extensions/:extension_key/:page_ref
```

Public single-collection mode uses:

```text
/extensions/:extension_key/:page_ref
```

The generic loader verifies that the extension is enabled and a bundled page
registration exists. The Terraforms page receives collection context, media
state, a base path, and page-local action scope; it does not own a privileged
top-level route.

### Structure Source

`shared/extensions/terraforms-structure.ts` mirrors contract-derived static
structure and exposes typed summaries:

- 20 levels and 11,104 total parcel positions;
- per-level dimensions and parcel counts;
- 75 named zones with palettes;
- 92 biomes, nine biome groups, and per-level group weights;
- nine topography buckets and deterministic bucket-to-zone mapping.

The module is shared contract data, not copied UI fixtures. Its tests assert
catalog size, uniqueness, bounds, group coverage, weights, and mapping behavior.

### Structure View

The current Structure section renders the complete 20-level isometric overview.
Each slab has a transient generated surface derived from a valid level zone and
palette. Hovered and selected level guides are compact; a click pins a level,
and `All Levels` selects the aggregate view.

Selection is URL-owned through the `level` query key and survives direct links,
back/forward navigation, and reload. The page preserves collection media source
and preference while intentionally dropping token-local variants and unrelated
trait filters.

The detail views provide:

- sortable zone rows for all levels or the selected level;
- exact live token counts from the backend trait catalog;
- zone palettes with copy feedback and selected-level texture preview;
- sortable biome rows and character previews;
- token-browser links scoped by level, zone, and biome;
- a page-owned reroll action rendered in the shared collection top-action row.

### Origins and Seed Classes

The second URL-owned section (`section=origins-seed-classes`) explains Origin
character sets and Seed Class rules with filtered token samples. Samples use the
normal collection read model and shared token card/preview components. Rerolling
changes the visible sample from the loaded pool; it does not synthesize token
state.

## Current Limits and Future Direction

- The generated slab textures are an illustrative structure view, not a
  parcel-by-parcel reconstruction of current onchain terrain or ownership.
- Selected levels do not yet present every static fact available in the shared
  structure module, such as explicit parcel capacity, biome-group weight detail,
  and the complete topography-bucket-to-zone explanation.
- There is no deep parcel grid or per-parcel navigation layer.
- Level and section are durable URL state. Transient rerolled surface seeds,
  active palette previews, table sorting, and sampled token choices are local UI
  state and intentionally reset.
- A future richer view must extend the Terraforms page module and generic page
  contract; it must not push Terraforms structure or palette rules into generic
  collection layout components.

Retained product-depth decisions are tracked as `BKL-054` and `BKL-055` in the
[unified backlog](../planning/01-unified-backlog.md).

## Verification

Source-level coverage includes shared structure/extension tests, indexer
extension and lifecycle tests, frontend helper/component tests, navigation
tests, and the deterministic Hypercastle Playwright suite.

```sh
yarn workspace @artgod/shared test
yarn workspace @artgod/indexer test
yarn workspace @artgod/frontend test
yarn test:terraforms:hypercastle
yarn test:terraforms:media
```

Rendered inspection is still required for overview geometry, guides, tables,
palette/biome previews, narrow layout, loading/error states, and both sections.
