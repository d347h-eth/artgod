# Terraforms Static Explorer Context

Status: context gathering and milestone shaping.

This document is the working context map for bringing Terraforms static trait and structure exploration into ArtGod through the collection-extension system. It intentionally captures durable facts as they are verified, so implementation work can proceed without repeatedly rediscovering collection-specific rules.

## Source Map

ArtGod references:

- `README.md`
- `AGENTS.md`
- `docs/extensions/01-collection-extensions.md`
- `docs/indexer/00-overview.md`
- `docs/indexer/04-sync-pipeline.md`
- `docs/indexer/05-storage-and-schema.md`
- `docs/indexer/08-domain-metadata.md`
- `docs/indexer/12-ports-and-adapters.md`
- `docs/indexer/14-collection-bootstrap.md`
- `docs/indexer/16-blockspace-exploration.md`
- `docs/progress/indexer/18-blockspace-isometric-view-plan.md`
- `docs/ui/01-interaction-guidelines.md`
- `frontend/src/lib/components/BlockspacePageView.svelte`
- `frontend/src/lib/components/BlockspaceIsometricGrid.svelte`

Terraforms reference sources inspected:

- `terraform-explorer/components/ZonesTable.tsx`
- `terraform-explorer/components/BiomesTable.tsx`
- `terraform-explorer/components/LevelsTable.tsx`
- `terraform-explorer/utils/traits.ts`
- `terraform-explorer/utils/zone-colors.ts`
- `terraform-explorer/utils/biome-characters.ts`
- `terraform-explorer/public/terraform-metadata.min.json`
- `terraforms/main/src/TerraformsZones.sol`
- `terraforms/main/src/TerraformsCharacters.sol`
- `terraforms/main/src/TerraformsDataStorage.sol`
- `terraforms/main/src/TerraformsData.sol`
- `terraforms/main/src/Terraforms.sol`

## Product Direction Decisions

The Terraforms structure is The Hypercastle. The explorer should make that structure the primary object, with Zones and Biomes as supporting trait systems.

Current decisions:

- Do not source implementation data from Terraform Explorer directly.
- Treat the Terraform Explorer tables and JSON as a comparison/reference surface only.
- Source ArtGod's Terraforms explorer data from the original smart contracts and ArtGod's local synced normalized metadata.
- Keep the new page strictly focused on static Hypercastle exploration, trait distribution, rarity, and structure.
- Do not include market, floor, bid/ask, or ownership overlays in this view.
- Add the explorer as a collection-page navigation tab.
- Place the tab between generic asset-feed tabs and custom extension-enabled event-feed tabs.
- Optimize the first UX for whole-structure and level exploration, not token/parcel lookup.

Initial drilldown model:

1. Show all 20 levels with a minimal Zone/Biome availability breakdown.
2. Drill into level groups, primarily grouped by shared or related Zone sets.
3. Drill into one level and show complete level information.
4. Represent each level's area at a stable scaled size relative to the other levels, rather than rendering every tile 1:1.
5. Defer deeper tile/token-level drilldown until after the structure, group, and level views are correct.

## ArtGod Extension Boundary

Collection extensions exist so collection-specific behavior can enrich ArtGod without corrupting the generic indexer model. Canonical metadata, ownership, and activity flows remain generic; extension behavior is an opt-in side path.

Current extension properties:

- Extensions are build-bundled and activated by DB install rows.
- v1 supports one enabled extension install per collection.
- Extension side effects are non-blocking. Canonical metadata writes, bootstrap ownership, and collection liveness must not depend on extension artifact completion.
- Backend presentation resolves extension-aware media/customization at read time without mutating canonical token metadata rows.
- Terraforms is the only embedded extension and is the blueprint for the current extension model.

Current Terraforms extension capabilities:

- exact embedded install matching by chain, contract address, and token scope
- sync-time watch specs for Terraforms-specific events
- version-2 renderer artifact refresh into `token_extension_artifacts`
- backend media overrides for token card/detail/preview responses
- extension-defined collection customization overrides for trait filters and compact trait summaries

Current extension-owned customization is still field-level, not page-level. The requested static explorer therefore needs a new generic contract that lets an installed collection extension contribute a full collection subpage with its own state/controller layer and representation layer.

## Existing Terraforms Metadata Behavior

Canonical token metadata remains authoritative. The Terraforms extension shadows it only after canonical metadata has been written.

The current Terraforms artifact path:

1. canonical metadata writes normalized token attributes
2. metadata/bootstrap code publishes `collection-extension.refresh-artifacts`
3. `collection-extension-worker` resolves the enabled install
4. Terraforms refresh logic reads normalized attributes plus renderer contracts
5. artifacts are upserted into `token_extension_artifacts`

Current artifact refs:

- `terraforms-v2-media`
- `terraforms-v2-lost-terrain` for non-Terrain tokens only

The backend exposes `artifact` and `snapshot` for collection browsing. `lost-terrain` is token-local and appears only where that token has the extra artifact.

## Existing Terraforms Trait Presentation

The Terraforms extension currently provides collection customization defaults:

- range trait filtering for numeric traits
- token card trait summary template
- activity row trait summary template

The shared summary template is:

```text
{Zone}/B{Biome}/{Chroma}/L{Level}
```

This proves that extension-owned presentation data can flow through backend read models while generic frontend components remain generic. It does not yet provide the richer static catalogs needed for Zones, Biomes, or Levels.

## Blockspace Lessons For The New Explorer

The blockspace UI is the strongest local precedent for a large, multi-level isometric explorer.

Useful patterns:

- the parent page owns state, summaries, refreshes, and action controls
- the isometric grid is isolated in a dedicated component
- presentation mapping lives in pure helpers where possible
- hard loads use route data, while in-page drilldown uses shallow navigation and component-owned fetching
- the renderer shows the current navigable path rather than a fully expanded tree
- visible tile counts stay bounded by rendering only the levels the user is actively inspecting

Differences for Terraforms:

- Terraforms has a fixed 20-level structure instead of an unbounded block-range hierarchy.
- The largest individual levels have more than 2,000 tiles, so the blockspace 32-by-32 / 1024-cell assumption cannot be reused without measuring browser performance.
- The requested page is mostly static/collection-known data, so it should not be modeled as a blockspace API clone unless live indexed state is actually needed.
- The first durable data source should be extension-owned Terraforms static data, not ad hoc literals scattered through frontend components.

## UI Constraints

The explorer should live inside the collection page shell and preserve ArtGod's shared userland chrome.

Rules that matter for this feature:

- collection navigation should be built through `collection-navigation.ts`
- URL state owns semantic navigation, filters, sorts, focused levels, and selected static catalog views
- component-only state is appropriate only for transient interaction details
- controls stay compact and left-aligned unless a specific full-width layout is required
- do not add redundant helper copy for obvious controls
- reuse existing tab/button/control families when the interaction matches existing collection pages
- feature-specific visualizations may be centered, but they must not mutate shared page shell or generic panel styles

## Initial Contract Direction

The requested page should not be implemented as a Terraforms-only hard-coded route in ArtGod core. That would violate the extension boundary that the project already established.

The better first milestone is a generic collection-extension page contract:

- shared extension registry advertises optional page contributions
- backend exposes installed extension page descriptors for a collection
- collection navigation can include extension-provided subpages
- frontend routes use a generic extension-page entry point that delegates to an extension-local view/controller
- Terraforms registers the first page contribution for static structure and trait exploration

The contract should stay build-bundled like the current extension system. Remote extension loading and multiple simultaneous extensions are already documented as out of scope for v1.

## Current ArtGod Extension Implementation

Current shared extension exports:

- `shared/extensions/index.ts`
    - core media modes: `snapshot`, `artifact`
    - media query param: `media_mode`
    - embedded extension matching by chain, contract address, and token scope
    - install payload shape for DB activation
- `shared/extensions/terraforms.ts`
    - `TERRAFORMS_EXTENSION_KEY = "terraforms"`
    - artifact refs for v2 media and lost terrain
    - Terraforms beacon/dream activity event keys
    - Terraforms mode, canvas, renderer, and config helpers
    - embedded mainnet contract match and renderer contract addresses

Current backend extension contract:

- trait filter presentation config
- token-card trait summary template config
- activity-row trait summary template config
- activity event feed descriptors
- collection/token media mode resolution
- artifact ref resolution
- token card/preview/detail media override mapping
- extension activity-event preview rendering
- extension token URI resolution

Current frontend extension ports:

- `frontend/src/lib/activity-extension-views/*` lets extensions register event-specific activity table columns, cells, and filters.
- `frontend/src/lib/collection-extension-navigation.ts` lets extensions register collection navigation groups, but the only target kind today is `activity-extension-event`.
- `frontend/src/lib/token-detail-extension-sections/*` lets extensions register token-detail sections.
- `frontend/src/lib/collection-extension-built-ins.ts` installs bundled Terraforms frontend extension registrations once from root layout startup.

This is close to the needed architecture but not enough for a full custom page. The next contract should extend the frontend navigation target set and route resolution to support a collection-extension page target, then add a generic route/component entry point that can render a registered extension page.

## Original Explorer Static Catalog Behavior

The original explorer tables are not independent static tables. They are views over one static minified token catalog plus utility arrays.

The catalog shape in `terraform-explorer/public/terraform-metadata.min.json` decodes through `decodeTerraform(...)` as:

```text
[tokenId, mode, biome, level, zone, chroma, x, y, questionMarks, seedValue]
```

The old table sources, used here only to understand feature parity, are:

- Zones table:
    - iterates `zoneColors` keys
    - derives count, levels, biomes, floor, and owned count from `byZone`
    - shows the 10-color palette from `zoneColors`
- Biomes table:
    - iterates `byBiome`
    - derives count, zones, levels, floor, and owned count
    - renders the 9-character biome set with the Mathcastles Remix font
- Levels table:
    - iterates `levelsList` from 1 through 20
    - derives count, zones, biomes, floor, owned count, and parcel list from `byLevel`

Rarity in those tables is display-only:

```text
count / total catalog count
```

The old static catalog contains 9,911 token rows. `TerraformsAdmin.sol` declares `MAX_SUPPLY = 11104`, `OWNER_ALLOTMENT = 1200`, and public `SUPPLY = 9904`; the extra 7 catalog rows are the origin/mintpass dream tokens represented by mode value `4`.

Observed catalog counts:

- modes: Terrain 9,348; Daydream 205; Terraform 191; Origin Daydream 160; Origin Terraform 7
- chroma: Flow 5,970; Pulse 2,915; Hyper 1,019; Plague 7
- zones: 75
- biomes: 92

Implementation boundary:

- Do not import this old minified catalog as ArtGod's canonical source.
- The ArtGod implementation should derive/verify token distribution from ArtGod's normalized local metadata DB and derive structural rules from the contracts.
- The old explorer can remain a parity checklist for what the user should be able to inspect.

Important identity warning:

- The old explorer's local `Zone` enum order does not match the Solidity `zoneNames` array order.
- The minified catalog stores local enum values, so future ArtGod data should key zones by stable zone name or explicit extension-local zone id, not by blindly reusing the old explorer's enum index as the onchain zone index.

## Solidity Static Data Rules

`TerraformsDataStorage.sol` contains the static generation tables:

- 20 level dimensions
- 8 topography thresholds
- level-to-zone windows via `zoneStartingIndex` and `zonesOnLevel`
- biome/character-set group windows via `charsetIndices` and `charsetLengths`
- per-level biome group weights via `charsetWeights`
- per-biome font sizes via `charsetFontsizes`

`TerraformsZones.sol` contains:

- 75 zone names
- 75 palettes, each with 10 CSS hex colors
- `tokenZone(index)` returning `(colors, name)`

`TerraformsCharacters.sol` contains:

- 92 biome character sets
- 9 unicode characters per biome
- one font id per biome
- owner-managed base64 font storage
- `characterSet(index)` returning `(characters, fontId)`

`TerraformsData.sol` contains the generation logic that ties those tables together:

- `levelAndTile(placement, seed)` rotates placement, then walks cumulative `levelDimensions[level] ** 2` capacity to resolve level and tile.
- `xOrigin(...)` and `yOrigin(...)` center each level inside the 48-by-48 maximum footprint.
- `zOrigin(...)` uses level spacing, token elevation, decay, and long-period oscillation.
- `tokenElevation(...)` maps Perlin topography to an integer range from `4` down to `-4`.
- `tokenZone(...)` maps topography bucket to a zone within that level's contiguous zone window.
- `characterSet(...)` chooses one of 9 biome groups with the current level's `charsetWeights`, then chooses a concrete biome index inside that group.
- `heightmapIndexFromTerrainValue(...)` compares Perlin terrain values against the 8 topography thresholds; values above each threshold select a lower index, otherwise the default is `8`.

The requested three static contracts are necessary but not sufficient by themselves. For implementation, use `TerraformsData.sol` as the canonical description of how the static arrays are interpreted.

## Level Catalog Summary

The old catalog's observed level counts differ from raw square capacity because not every level grid slot corresponds to a minted parcel in the 9,911-row token catalog.

| Level | Dimension | Capacity | Parcels | Empty Slots | Zone Count | Biome Count |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| 1 | 4 | 16 | 13 | 3 | 1 | 9 |
| 2 | 8 | 64 | 58 | 6 | 1 | 37 |
| 3 | 8 | 64 | 59 | 5 | 1 | 44 |
| 4 | 16 | 256 | 222 | 34 | 1 | 19 |
| 5 | 16 | 256 | 217 | 39 | 3 | 27 |
| 6 | 24 | 576 | 523 | 53 | 6 | 58 |
| 7 | 24 | 576 | 515 | 61 | 5 | 66 |
| 8 | 24 | 576 | 513 | 63 | 6 | 63 |
| 9 | 16 | 256 | 230 | 26 | 3 | 32 |
| 10 | 32 | 1024 | 924 | 100 | 8 | 81 |
| 11 | 32 | 1024 | 913 | 111 | 7 | 81 |
| 12 | 16 | 256 | 227 | 29 | 2 | 56 |
| 13 | 48 | 2304 | 2075 | 229 | 9 | 62 |
| 14 | 48 | 2304 | 2044 | 260 | 8 | 62 |
| 15 | 24 | 576 | 509 | 67 | 9 | 62 |
| 16 | 24 | 576 | 513 | 63 | 7 | 62 |
| 17 | 16 | 256 | 236 | 20 | 1 | 74 |
| 18 | 8 | 64 | 53 | 11 | 1 | 29 |
| 19 | 8 | 64 | 54 | 10 | 1 | 32 |
| 20 | 4 | 16 | 13 | 3 | 1 | 11 |

Level zone windows from the Solidity arrays:

| Level | Zones |
| --- | --- |
| 1 | Kairo |
| 2 | Kairo |
| 3 | Kairo |
| 4 | Kairo |
| 5 | Xleph, Tetsu, Royal |
| 6 | Rocket, Toad, Ender, Bubble, Angel, Mori |
| 7 | Mt Zuka, First Earth, Zerinia, Intro Forest, Jadeite |
| 8 | Promiselands, Cradle, Everglades, Kippsun, Calyx, Akileaf |
| 9 | Dhampir, Aria, Wastelands |
| 10 | [MOON], [NEON], [CUR2], [HYCA], [YUNA], [SEP], [NOV], [SUN] |
| 11 | [HOME], [MENU], [BOSS], [BLOOD], [DARK], [WEN], [SOON] |
| 12 | Palace, Muxtai X1 |
| 13 | Mecha, Grove, Nightrose, Hypermage, Arc, Dynacrypts, Aetherking, Valeria, Killscreen |
| 14 | Holo, Shiro, Mirage, Hyphae, Riso, Exduo, Radiant, Warp |
| 15 | Venmon, Blushing, Linosim, pfpfpfpbbx80, Pepo, Avidana, Shahra, Antenna, Gemina |
| 16 | Ouallada, Mould, Blossom, Greysunn, Treasure, Uwo, Dread |
| 17 | Alto |
| 18 | Alto |
| 19 | Alto |
| 20 | Alto |

Biome group ranges:

| Group | Biome Indices | Count |
| --- | --- | ---: |
| 0 | 0-20 | 21 |
| 1 | 21-42 | 22 |
| 2 | 43-49 | 7 |
| 3 | 50-58 | 9 |
| 4 | 59-65 | 7 |
| 5 | 66-72 | 7 |
| 6 | 73-76 | 4 |
| 7 | 77-82 | 6 |
| 8 | 83-91 | 9 |

The page UI should preserve both forms of biome information:

- concrete biome index, character set, font id, and font size
- higher-level biome group membership and per-level group weight

## Static Data Implementation Direction

Do not copy the old React table logic or its minified JSON fixture into Svelte components.

Better shape:

- Put Terraforms static structure data in extension-local typed modules, probably under a Terraforms frontend/shared extension directory.
- Keep full zone palettes and biome charsets as data, not component literals.
- Generate or hand-transcribe static contract arrays from the Solidity sources with tests that make drift obvious.
- Use ArtGod's normalized local metadata as the source for token trait distribution and rarity.
- Build derived indexes with pure helpers:
    - by level
    - by zone
    - by biome
    - by zone+biome
- Expose level, level-group, zone, and biome rows for table-like deep dives, but make the primary page a structure-first visualization.
- Keep tile/token lookup out of the initial UI unless it is needed to explain a selected level.
- Keep the ArtGod core generic: it should know that an extension page exists and how to route/render it, not what a Zone, Biome, or Level means.

The existing `frontend/static/fonts/MathcastlesRemix-Regular.woff2` should be wired as the Terraforms biome font. The original explorer used the font family label `Mathcastles Remix` and rendered each biome as a row of 9 inline glyphs.

## Visualization Direction

The primary visualization should be a fixed 20-level explorer:

- first viewport shows the whole Hypercastle stack at a glance
- each level shows compact Zone/Biome availability
- selecting a level group focuses related levels, primarily by Zone-set relationships
- selecting a level focuses complete level information
- side/deep-dive panels expose complete level, zone, and biome catalog rows
- the UI should support table-grade sorting/filtering for the catalog data without making tables the primary experience
- the initial view should not require rendering every tile 1:1

Rendering risk:

- blockspace currently uses up to 1024 tiles per level and dynamically imports `@elchininet/isometric`
- Terraforms levels 13 and 14 require 2,075 and 2,044 parcel tiles if rendered at 1:1
- a performance spike is likely if the same SVG-per-tile approach is used directly for a 48-by-48 level

The implementation should include a browser performance spike before committing to the renderer shape for full levels. Candidate approaches:

- render levels as scaled area shapes that preserve relative size and broad structure
- render Zone/Biome availability summaries on each shape rather than individual parcel tiles
- render dense parcel grids only in a later drilldown if the product needs token-level exploration
- virtualize or canvas-render large focused levels
- use SVG/isometric for the 20-level shell and a simpler grid/canvas layer for dense level inspection
- preserve full data access through side panels even if the overview is aggregated

## Recommended Milestones

### Milestone 1: Static Catalog Module

Goal: make all Terraforms static contract data and local metadata-derived distributions available through extension-local typed helpers, with tests before any UI depends on it.

Expected work:

- add Terraforms static data modules for levels, zones, biomes, palettes, character sets, dimensions, topology, and weights
- add a local metadata-derived read path or generated fixture that produces clear domain records:
    - token id
    - mode
    - level
    - x/y coordinate
    - zone name
    - biome index
    - chroma
    - question mark count
    - seed value
- build pure derived indexes and row builders for the three legacy static trait views
- test static contract totals and local metadata-derived distribution counts
- decide whether static data lives in `frontend` only or in `shared/extensions/terraforms/*`

Acceptance checks:

- token record count derived from the selected local metadata source and documented in tests
- 75 zones
- 92 biomes
- 20 levels with contract-derived dimensions, capacities, zone windows, and biome group weights
- level/mode/chroma distribution counts derived from local normalized metadata
- every zone has 10 colors
- every biome has 9 characters plus font metadata

### Milestone 2: Generic Collection-Extension Page Contract

Goal: allow installed collection extensions to contribute collection-scoped pages without hard-coding Terraforms into core navigation.

Expected work:

- extend frontend extension navigation target kinds beyond activity events
- add an extension page target shape with stable ids and labels
- add a generic collection-extension page route
- resolve page availability from the collection's installed/enabled extension descriptors
- keep core route load generic and delegate only after the extension page is resolved
- allow extension pages to declare their collection-tab placement relative to generic asset feeds and extension event feeds
- preserve collection navigation state such as `media_mode` and trait filters only when the target page declares that it understands them

Likely route shape:

```text
/:chain_ref/:collection_ref/extensions/:extension_key/:page_ref
```

This route keeps the core path generic and avoids giving Terraforms a privileged top-level route. The user-visible tab should appear inside the collection page between the generic asset-feed tabs and extension-enabled event-feed tabs. A later UX pass can choose whether the tab label shown to users is `Hypercastle`, `Structure`, or another extension-provided label.

### Milestone 3: Terraforms Catalog Page Registration

Goal: register the Terraforms static explorer as the first extension-owned page contribution.

Expected work:

- register a Terraforms page descriptor through the bundled frontend extension installer
- implement a Terraforms page controller that owns:
    - focused level group
    - focused level
    - active catalog lens
    - sort state for deep-dive data
    - URL serialization for shareable focus state
- implement compact catalog panels for:
    - levels
    - zones
    - biomes
- no token/parcel detail panel in the first implementation unless a level view cannot be understood without it
- add the Mathcastles Remix font face in the Terraforms extension UI boundary

### Milestone 4: Visualization Spike

Goal: verify the renderer choice before committing to a large structure visualization implementation.

Expected work:

- create a static in-browser spike using the full 20-level Hypercastle overview and focused level representations
- compare:
    - current `@elchininet/isometric` SVG rectangle approach
    - scaled area/shape representations without 1:1 parcel tiles
    - canvas or hybrid level renderer
    - aggregated overview plus focused detail renderer
- measure first render time, interaction latency, memory, and mobile layout pressure
- use Playwright screenshots and pixel checks once a candidate renderer exists

The spike should happen before building polish around a renderer. The first accepted renderer should make the 20-level structure readable and responsive before attempting any tile-dense mode.

### Milestone 5: Full Explorer UX

Goal: replace table-first browsing with a structure-first Terraforms exploration page while preserving complete catalog access.

Expected work:

- whole-structure overview for 20 levels
- level-group focus/drilldown based primarily on Zone relationships
- level focus/drilldown with complete level data
- zone palette inspection with level/biome relationships
- biome character inspection using Mathcastles Remix
- sortable deep-dive panels for level, zone, and biome rows
- no market, floor, bid/ask, or ownership overlays

## Suggested First Implementation Rule

Keep immutable Terraforms structure separate from live ArtGod state.

Static contract data should answer:

- what exists in the Terraforms structure
- where each parcel sits
- which zones and biomes are possible on each level
- how palettes, character sets, weights, and static rarity work

Local normalized metadata should answer:

- current token mode from canonical metadata
- token trait distribution
- token-derived rarity counts
- any distribution facts not directly recoverable from the static arrays alone

Market and ownership state should stay out of this page. Mixing market data into the Hypercastle explorer would make the purpose weaker and the verification surface larger without serving the requested static exploration goal.

## Open Questions

- Should Terraforms contract arrays be generated from Solidity into TypeScript, manually mirrored with tests, or exposed through a small build-time extraction tool?
- Should local metadata-derived distribution stats be served by backend read models or precomputed into an extension-local static fixture during development?
- What exact level groups emerge from shared Zone-set relationships once grouped intentionally instead of only by visual stack position?
- How much of the original table behavior should remain as a deep-dive panel versus a separate sortable grid inside the new visualization page?
- Should the first extension-page contract support SSR data loading, or should Terraforms v1 be client-only after the generic route resolves collection/install state?
- What minimum browser-performance threshold should the whole-Hypercastle renderer satisfy before accepting the visualization approach?
