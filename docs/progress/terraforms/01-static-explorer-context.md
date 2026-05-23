# Terraforms Static Explorer Context

Status: context gathering.

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

Terraforms reference sources still to be mined:

- `terraform-explorer/components/ZonesTable.tsx`
- `terraform-explorer/components/BiomesTable.tsx`
- `terraform-explorer/components/LevelsTable.tsx`
- `terraforms/main/src/TerraformsZones.sol`
- `terraforms/main/src/TerraformsCharacters.sol`
- `terraforms/main/src/TerraformsDataStorage.sol`

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

## Open Questions

- Should extension pages appear as standalone top-level collection tabs, grouped under an extension menu, or as a collection-specific `explore` child?
- Should Terraforms static catalogs be served by backend read models, imported as frontend static modules, or shared through `@artgod/shared` extension data?
- Should the first implementation include indexed collection statistics, or only protocol/static rarity rules from the original contracts?
- How much of the original table behavior should remain as a deep-dive panel versus a separate sortable grid inside the new visualization page?
- What minimum browser-performance threshold should the isometric level renderer satisfy before accepting 2,000-plus tile levels?
