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
- Source the first-pass ArtGod Terraforms explorer data from the original smart contracts.
- Keep the new page strictly focused on static Hypercastle exploration, trait data, original contract-based distribution, original rarity, and structure.
- Treat ArtGod's local synced normalized metadata as the source for a later minted/exact rarity mode, not for the first pass.
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

Rarity modes:

- First pass: original/contract-based rarity and fixed distribution rules engaged by the mint.
- Later pass: minted/exact rarity backed by ArtGod's normalized token metadata.

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
[tokenId, mode, biome, level, zone, chroma, x, y, resource, seedValue]
```

The old source calls the ninth field question marks. ArtGod prose and UI should call it `Resource`.

The old table sources, used here only to understand feature parity, are:

- Zones table:
    - iterates `zoneColors` keys
    - derives count, levels, and biomes from `byZone`
    - shows the 10-color palette from `zoneColors`
- Biomes table:
    - iterates `byBiome`
    - derives count, zones, and levels
    - renders the 9-character biome set with the Mathcastles Remix font
- Levels table:
    - iterates `levelsList` from 1 through 20
    - derives count, zones, biomes, and parcel list from `byLevel`

The legacy tables also displayed market floor and connected-wallet owned counts. Those are explicitly out of scope for the ArtGod Hypercastle explorer.

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
- The first ArtGod implementation should derive structure, availability, and original rarity from the contracts.
- Exact minted-token rarity should be a later mode that reads ArtGod's normalized local metadata DB.
- The old explorer can remain a parity checklist for what the user should be able to inspect.
- Token `seedValue` is not exposed through the tokenURI payload and is not captured by the existing normalized metadata path. It matters for hidden X/Y seed traits, but seed persistence is a separate task and should not block the first Hypercastle structure pass.

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

- `levelAndTile(placement, seed)` rotates placement, then walks cumulative `levelDimensions[level] ** 2` parcel slots to resolve level and tile.
- `xOrigin(...)` and `yOrigin(...)` center each level inside the 48-by-48 maximum footprint.
- `zOrigin(...)` uses level spacing, token elevation, decay, and long-period oscillation.
- `tokenElevation(...)` maps Perlin topography to an integer range from `4` down to `-4`.
- `tokenZone(...)` maps topography bucket to a zone within that level's contiguous zone window.
- `characterSet(...)` chooses one of 9 biome groups with the current level's `charsetWeights`, then chooses a concrete biome index inside that group.
- `heightmapIndexFromTerrainValue(...)` compares Perlin terrain values against the 8 topography thresholds; values above each threshold select a lower index, otherwise the default is `8`.

The requested three static contracts are necessary but not sufficient by themselves. For implementation, use `TerraformsData.sol` as the canonical description of how the static arrays are interpreted.

## Level Catalog Summary

The old catalog's observed level counts differ from raw square parcel slots because not every level grid slot corresponds to a minted parcel in the 9,911-row token catalog.

The `Parcels`, `Empty Slots`, and concrete `Biome Count` columns below are useful as comparison context from the legacy catalog. They are not first-pass acceptance criteria. The first pass should depend on contract-derived dimensions, capacities, Zone windows, topography rules, and biome group weights.

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
- Use contract data as the first-pass source for original rarity and fixed distribution rules.
- Do not read ArtGod's normalized metadata or add generated token-specific fixtures in this first pass.
- Introduce DB-backed minted/exact rarity only as a later explicit mode.
- Build derived indexes with pure helpers:
    - by level
    - by zone
    - by biome
    - by zone+biome
- Expose level, level-group, zone, and biome rows for table-like deep dives, but make the primary page a structure-first visualization.
- Keep token-specific records, tile lookup, and seed-based hidden traits out of the initial UI.
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

### Milestone 1: Static Structure Module

Goal: make Terraforms' fixed Hypercastle structure, Zone catalog, Biome catalog, and contract-derived original rarity/distribution rules available through extension-local typed helpers, with tests before any UI depends on them.

Expected work:

- add Terraforms static data modules for levels, zones, biomes, palettes, character sets, dimensions, topology, and weights
- model Level, Zone, Biome, Resource, topography, and biome group concepts directly from contract data
- build pure derived indexes and row builders for structure-first views:
    - levels
    - level groups
    - zones
    - biomes
    - zone availability by level
    - biome group weights by level
- keep all first-pass distribution and rarity values contract-derived
- do not prepare token-specific generated fixtures in this milestone
- test static contract totals and derived structure summaries
- decide whether static data lives in `frontend` only or in `shared/extensions/terraforms/*`

Acceptance checks:

- 75 zones
- 92 biomes
- 20 levels with contract-derived dimensions, capacities, zone windows, and biome group weights
- original rarity/distribution views are clearly labeled as contract-based, not exact minted rarity
- level groups can be derived from Zone-set relationships without token-specific records
- no token-specific fixture is introduced in the first pass
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

Current implementation notes:

- `frontend/src/lib/collection-extension-pages/` owns the frontend page registry, page outlet, and generic page load helper.
- `frontend/src/lib/collection-extension-navigation.ts` supports activity-event targets and collection-extension page targets.
- Page tabs resolve only when the collection's enabled extension descriptors include the target extension and a frontend page registration exists.
- `frontend/src/lib/collection-navigation.ts` exposes `hrefs.extensionPage()`. It preserves `media_mode` only when the page target opts in; trait filters are not carried into static extension pages by default.
- Generic routes exist for standard collection pages and public single-collection deployments:
    - `/:chain_ref/:collection_ref/extensions/:extension_key/:page_ref`
    - `/extensions/:extension_key/:page_ref`
- Route load stays generic: it fetches collection context, checks the extension is enabled for that collection, and leaves page-specific behavior to the registered frontend extension page.

### Milestone 3: Terraforms Page Wiring

Goal: register the Terraforms Hypercastle page as the first extension-owned page contribution and prove the generic core/frontend wiring works end to end.

Expected work:

- register a Terraforms page descriptor through the bundled frontend extension installer
- keep the registered page body intentionally empty
- verify the standard collection route can resolve the installed Terraforms extension and delegate to the registered page
- verify the public single-collection route can resolve the same page through the public route shape
- keep route loading generic: collection context and extension availability checks belong in core, while Terraforms owns only its page registration
- keep navigation generic: core tabs should consume extension-provided target descriptors without hard-coding Terraforms page ids
- add or keep focused tests for navigation target resolution, route href generation, and extension-page availability filtering
- do not add page-local controller state, URL focus state, catalog state, visual components, font wiring, or placeholder UI in this milestone

Current implementation notes:

- Terraforms registers the first page contribution as `terraforms:hypercastle`.
- The Hypercastle tab is extension-owned and ordered between generic asset-event tabs and Terraforms extension-event tabs.
- `frontend/src/lib/collection-extension-pages/terraforms/TerraformsHypercastlePage.svelte` should remain an empty extension page body at this milestone.
- Any helpers or components that imply a rendered Hypercastle, level focus, Zone/Biome panels, catalog tables, or renderer spike belong in later milestones, not here.

Acceptance checks:

- the Hypercastle tab appears only when the collection has the enabled Terraforms extension and a matching frontend page registration
- the standard extension route loads collection context and delegates to the registered page without Terraforms-specific route code
- the public single-collection extension route loads the same page through `/extensions/:extension_key/:page_ref`
- missing extension installs and unknown extension pages do not expose a usable page
- no Hypercastle representation layer is rendered yet

### Milestone 4: Hypercastle Overview Render

Goal: make the first visible page content the full Hypercastle: a simplified 20-level isometric structure rendered with `@elchininet/isometric`.

Status: complete. The accepted browser state is the 20-level overview with compact gaps, blue slab faces, hidden-line outlines, hover-only level leaders, and reactive right-side level labels.

Expected work:

- render one isometric layer for each of the 20 contract levels
- render every level as a simplified square slab, not as individual parcel tiles
- size each square slab relative to the level's contract grid area
- align all slabs around one shared vertical spine through the center of every level
- stack slabs into a bicone-like isometric silhouette
- keep gaps between slabs readable without breaking the single-stack silhouette
- keep every slab the same layer height
- use one shared color for all slabs in this first overview pass
- make each slab selectable by pointer/keyboard, but keep selection behavior as a no-op for now
- keep the overview independent from token records, minted rarity, market data, ownership data, Zone/Biome detail panels, and catalog tables
- verify the overview in browser with screenshots and pixel checks before treating the first renderer as accepted

Acceptance checks:

- the page's first content signal is the 20-level Hypercastle overview inside the collection page shell
- all 20 levels are visible and aligned to a shared center spine
- relative level sizes match contract dimensions/areas closely enough to make the widest levels visually dominant
- layer gaps are compact and consistent
- no Zone, Biome, level-detail, catalog, market, ownership, token-detail, or rarity panels are rendered
- selecting a level does not yet change URL state or render a detail view
- desktop and mobile screenshots show a nonblank, coherent isometric structure with no shell overlap

Current implementation notes:

- `frontend/src/lib/collection-extension-pages/terraforms/TerraformsHypercastleOverview.svelte` renders the first overview using `@elchininet/isometric`.
- `frontend/src/lib/collection-extension-pages/terraforms/hypercastle-overview.ts` owns the slab geometry, centered-spine layout, and render key.
- The overview renders 20 level groups and 60 faces, with filled blue vertical faces, transparent top faces, every level centered on one spine, gaps at triple the slab height, and full vertical-face hit targets. Milestone 5 now wires those hit targets to selected-level page state.
- Hidden-line rendering is explicit: visible rear top outlines stay solid until intersected by higher slab silhouettes, hidden rear top outlines become dotted, and rear bottom outlines are always drawn as dotted blue segments.
- Level 12 uses faded striped vertical faces and dotted vertical-face outlines to show that it is occluded by the larger Level 13 slab.
- Right-side level guide labels render one dashed 1px leader from each slab's lower right corner to a shared cutoff only while the label or slab is hovered, with either hover target applying the same hover treatment to the corresponding slab and label.
- Focused helper tests cover level count, relative area sizing, gap/height ratio, face anchoring, centered layout, and render-key stability.
- `yarn test:terraforms:hypercastle` runs the fixture-backed Playwright page harness, records an in-browser SVG/interaction probe, and attaches default plus hover screenshots for visual iteration.
- Browser verification covered desktop and mobile screenshots plus SVG pixel checks for nonblank rendering and centered layer alignment.

### Milestone 5: Level Drilldown Foundation

Goal: turn the overview into the entry point for level exploration, then render one selected level with basic static structure detail.

Status: in progress. The first accepted slice is Zone-only detail: selecting the aggregate `All Levels` label shows the full Zone catalog, while selecting an overview slab or level label keeps the full Hypercastle visible, marks that level selected, and shows that level's possible Zones in a right-side sortable table.

Expected work:

- reuse the accepted overview slabs and reactive level labels as the entry points for level selection
- make level selection URL-backed and shareable after the overview renderer is accepted
- preserve the full 20-level overview as the user's way back to structure context
- render the selected level in more detail than the overview, still without token-level tiles unless a later performance pass proves it is needed
- expose the selected level's contract-derived dimensions, parcel capacity, Zone window, topography-to-Zone mapping, and biome group weights
- show which Zones and Biome groups can exist on that level
- wire Mathcastles Remix only when concrete Biome character inspection is introduced
- keep market, floor, bid/ask, ownership overlays, minted/exact rarity, seed-derived hidden traits, and token/parcel detail out of this milestone

Acceptance checks:

- clicking or keyboard-selecting a level can focus that level through URL-backed state
- the selected level view uses contract-derived static data only
- the selected level view explains Zone and Biome availability without pretending to show exact minted rarity
- users can return from selected-level focus to the full Hypercastle overview
- the renderer remains responsive on desktop and mobile screenshots
- no market, floor, bid/ask, or ownership overlays

Current implementation notes:

- `frontend/src/lib/collection-extension-pages/terraforms/TerraformsHypercastlePage.svelte` now splits the Hypercastle page into a left overview column and a right Zone detail column. The detail column stays empty until the user selects `All Levels` or a concrete level.
- `frontend/src/lib/collection-extension-pages/terraforms/TerraformsHypercastleOverview.svelte` exposes selected-level and all-level selection callbacks, and applies persistent selected styling plus `aria-pressed` to slab groups, level guide labels, and the all-level label.
- `frontend/src/lib/collection-extension-pages/terraforms/level-zones.ts` builds selected-level Zone rows and the all-level Zone catalog from static contract data only.
- `frontend/src/lib/collection-extension-pages/terraforms/hypercastle-selection.ts` owns extension-local selection labels and state helpers for `All Levels` and `Level X` headings.
- The all-level Zone table shows `name` and the 10-swatch `palette` for all 75 Zones.
- The selected-level Zone table shows `name`, the 10-swatch `palette`, and centered `topography buckets`.
- `topography buckets` means the count of nine contract topography buckets that map to the Zone on that level. It is a static mapping aid, not a faithful rarity or parcel distribution column.
- Zone table headers are sortable; default order is name ascending. Removed the earlier bucket-share column because it implied equal bucket probability that the contract noise thresholds do not guarantee.
- `frontend/e2e/terraforms-hypercastle.spec.ts` now clicks `All Levels` and Level 12 in browser, verifies selected state, verifies Zone table rows and sorting, and attaches default, all-level, hover, and selected-level screenshots on desktop and mobile.

Remaining work:

- Make `All Levels` and selected-level state URL-backed and shareable.
- Add a faithful static Zone distribution mode by replaying the contract placement, Perlin, and threshold logic against the deployed seed, then generate per-level counts for the table.
- Add the rest of the selected-level static facts: dimensions, parcel capacity, Zone window, explicit topography-to-Zone mapping, and biome group weights.
- Decide whether the selected-level panel should remain a compact side panel or introduce a deeper level-focused view before adding Biome detail.

## Suggested First Implementation Rule

Keep the first implementation centered on aggregate Hypercastle structure, not individual tokens.

Static contract data should answer:

- what exists in the Terraforms structure
- which zones and biomes are possible on each level
- which level groups emerge from related Zone sets
- how palettes, character sets, topography, weights, and original contract-based rarity rules work

The later minted/exact rarity mode should answer:

- token trait distribution
- token-derived rarity counts
- any exact minted-token distribution facts not directly recoverable from the static arrays alone

Market, ownership, token-detail drilldown, minted/exact rarity, and seed-based hidden traits should stay out of this first pass. Mixing them into the Hypercastle explorer now would make the purpose weaker and the verification surface larger without serving the requested static exploration goal.

## Open Questions

- Should Terraforms contract arrays be generated from Solidity into TypeScript, manually mirrored with tests, or exposed through a small build-time extraction tool?
- What exact level groups emerge from shared Zone-set relationships once grouped intentionally instead of only by visual stack position?
- How much of the original table behavior should remain as a deep-dive panel versus a separate sortable grid inside the new visualization page?
- Later minted/exact rarity mode: should it be served by backend read models over normalized metadata, or can existing `collection_trait_stats` plus targeted joins cover the UI?
