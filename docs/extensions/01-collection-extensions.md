# Collection Extensions

Scope: shared extension registry, indexer extension runtime, backend extension resolution, and collection-scoped extension overrides.

This document is the dedicated overview for the collection-extension system. It complements the indexer docs that already describe bootstrap, sync, storage, and metadata flow, but it focuses specifically on what the extension system enables today and how those pieces fit together end to end.

## Purpose

Collection extensions exist so ArtGod can support collection-specific behavior without corrupting or replacing the canonical core data model.

The design goal is:

- keep canonical metadata, ownership, and activity flows generic
- allow collection-specific enrichment and presentation as an opt-in side path
- keep extension behavior build-bundled and DB-activated rather than hard-wired to whichever process is currently running

Current implementation is intentionally narrow and conservative.

## Core Principles

1. Canonical metadata remains authoritative.
   Extension behavior must not replace `token_metadata` as the source of truth.

2. Extensions are build-bundled and DB-activated.
   Runtime code is shipped with the app, while actual collection activation is controlled by DB install rows.

3. Extension side-effects are non-blocking.
   Canonical metadata writes, ownership bootstrap, and collection liveness must not depend on extension artifact completion.

4. Extension presentation is resolved at read time.
   Backend can expose effective collection-specific media or customization without mutating the canonical rows.

5. Current precedence is simple.
   v1 supports at most one enabled extension install per collection.

## What The Extension System Enables Today

### 1. Embedded extension auto-install during bootstrap

When a collection bootstrap request exactly matches a known embedded extension by:

- `chain_id`
- contract address
- token scope

the bootstrap flow persists that requested extension key and installs it onto the collection during bootstrap start.

Shared registry and embedded definitions live in:

- `shared/extensions/index.ts`

Current matching is intentionally explicit rather than open-ended.

### 2. Sync-time collection-specific watch specs

Indexer extensions can contribute additional onchain watch specs during sync.

Those watch specs can normalize into collection-scoped metadata refresh events/ranges and immutable extension event facts. Extension event facts are generic at the storage/feed boundary; collection-specific payload semantics stay inside the concrete extension.

Indexer extension contract lives in:

- `indexer/src/application/collection-extensions/types.ts`

Indexer runtime wiring lives in:

- `indexer/src/runtime/sync-worker.ts`

### 3. Artifact refresh as an eventual side path

After a successful canonical metadata write, the system can enqueue collection-extension artifact refresh work.

Those jobs are consumed by:

- `indexer/src/runtime/collection-extension-worker.ts`

and persist extension-owned token artifacts separately from canonical metadata.

Current artifact storage:

- `collection_extension_installs`
- `token_extension_artifacts`
- `collection_extension_synthetic_token_retirements`

Extensions can also replace extension-owned normalized token traits in the
shared attribute tables. These traits are first-class browse/filter traits, but
they are source-scoped to the extension so canonical tokenURI metadata refreshes
do not delete them and extension refreshes do not mutate `token_metadata`.

This means:

- canonical metadata can succeed even when extension refresh is delayed or failing
- backend presentation can converge later once artifacts exist
- extension-supplied traits can participate in the same facets, range filters,
  stats, and token-card attributes as tokenURI traits
- extension-owned synthetic rows can be retired durably when real token state
  replaces them

### 4. Backend presentation overrides

Backend resolves effective token presentation through an extension-aware read layer.

Today that includes:

- collection media-source resolution, including extension-provided sources exposed through the normal `media_mode` URL contract
- extension-owned collection media preferences exposed through `media_preference`
- token-local media-variant resolution through `media_variant`
- token card image override
- token detail image / animation override
- activity token include media override

Relevant backend pieces:

- `backend/src/application/collection-extensions/types.ts`
- `backend/src/application/collection-extensions/index.ts`
- `backend/src/infra/collections/extension-aware-collection-detail-read.ts`

The backend still returns one effective media set per token response. A token response can describe the available source and variant choices, but extensions do not cause every media payload to be emitted in parallel.

### 5. Collection-scoped customization overrides

This is the newest extension-owned capability.

Extensions can now provide read-only collection customization overrides, while users can still maintain editable collection-specific configuration in the DB and select whether the effective source for that feature is:

- `user`
- `extension`

Current persisted customization storage:

- `collection_customization_features`

Current backend resolver:

- `backend/src/infra/collections/extension-aware-collection-customization.ts`

This makes collection customization an extension-system feature, not a Terraforms-only frontend trick.

## Current Data And Control Flow

### Shared registry layer

`shared/extensions/index.ts` defines:

- known extension keys
- embedded install matching rules
- the generic snapshot media source
- shared media query keys and preference values
- extension-owned config parsing helpers

This file is the stable cross-runtime registry.

### Indexer layer

Indexer extensions currently own:

- sync watch specs
- artifact refresh logic
- extension-owned normalized trait enrichment

They do **not** currently own backend presentation logic directly.

### Backend layer

Backend extensions currently own:

- media sources exposed for a collection
- default media source
- optional media-preference state
- token-local media variants and their default-selection rules
- artifact ref resolution for an effective token variant
- effective token card/detail projection
- extension-defined trait filter presentation config
- extension-defined token-card trait summary template
- extension-defined activity-row trait summary template

This split keeps each runtime on its own contract instead of sharing a single cross-runtime implementation object.

## Blueprint Extension: Terraforms

The only existing embedded extension today is:

- `terraforms`

It should be treated as the blueprint implementation for the current extension system.

### What Terraforms currently demonstrates

1. Embedded install resolution by exact collection contract + token scope
2. Sync-time custom watch specs
3. Artifact refresh into `token_extension_artifacts`
4. Extension-owned normalized trait enrichment
5. Backend media override from artifact-backed and request-time extension media
6. Extension-defined collection customization override

### Current Terraforms artifact usage

Terraforms caches version-2 media artifacts using:

- `extension_key = "terraforms"`
- `artifact_ref = "terraforms-v2-media"`
- `artifact_ref = "terraforms-v2-lost-terrain"` for non-Terrain tokens only
- Terraforms mode transitions move one way away from Terrain, so a Terrain
  artifact refresh is not treated as a stale lost-terrain cleanup signal
- minted non-Terrain tokens can also receive `Seasons = Season 0` as an
  extension-owned normalized trait when the Beacon contract reports a first
  antenna-on mutation before the fixed Season 0 cutoff

The backend separates collection media source from token-local media variant:

- collection sources are `snapshot` and extension-provided `live`
- `media_mode` owns the selected source
- `media_preference=enabled|disabled` owns the extension preference; Terraforms
  labels it `prefer V2`, enables it by default, and omits the default
  value from generated URLs
- `media_variant` identifies one token-local choice and is not a collection-wide
  rendering mode

Snapshot variant availability comes from persisted state:

- `V2 artifact` exists when `terraforms-v2-media` exists
- `V2 lost terrain` exists for canonical tokens when
  `terraforms-v2-lost-terrain` exists
- canonical `V2` exists only when canonical metadata has both an animation and
  normalized `Version = 2.0`
- canonical `V0` is the temporary label for canonical animation without that V2
  trait; normalized metadata cannot currently distinguish V0 from V1
- the V2 artifact and canonical V2 choices may coexist because they represent
  different persisted media
- extension-owned synthetic tokens have no canonical metadata and expose only
  their V2 artifact

Default snapshot selection applies the preference without hiding explicit
choices:

- canonical preference enabled: `V2 artifact` -> canonical `V2` -> canonical
  `V0`
- canonical preference disabled: canonical `V2` -> canonical `V0`; an artifact
  remains explicitly selectable but is not selected automatically
- synthetic tokens keep their sole `V2 artifact` selected regardless of the
  preference because they have no canonical media
- `V2 lost terrain` is never selected automatically; it requires explicit user
  intent

Live media is available only to canonical numeric token ids. It exposes explicit
`V2`, `V1`, and `V0` choices, reconstructs current token state from one pinned
block, and invokes the selected Terraforms renderer. It does not use the artifact
lane's Daydream canvas override. With the preference enabled, live opens on V2;
with it disabled, live opens on the token's owner-selected renderer.

Important read-path rules:

- token cards in `live` still use the canonical metadata image and do not
  perform per-card live contract reads
- fullscreen preview and token detail resolve live animation HTML through the
  same backend request; failures use normal request error behavior
- live preview requests bypass backend/frontend preview caches and adjacent-token
  prefetch
- activity-event preview render modes remain their separate extension-event
  contract and are not Terraforms token media variants

### Current Terraforms customization override

Terraforms now also provides example collection customization overrides through the backend extension contract.

Current Terraforms overrides:

- trait filter presentation
- token card trait summary template
- activity row trait summary template

Current shared token-card and activity-row template:

```text
{Zone} B{Biome} {Chroma} L{Level}
{Mode}{{#if Antenna=On}} A{{/if}}{{#if Seasons=Season 0}} S0{{/if}}{{#if Seed Class}} {Seed Class}{{/if}}
```

This is important because it demonstrates that extension-owned collection customization is not limited to media.

## Collection Trait Filter Presentation Override

The first collection customization feature implemented on top of the extension system was:

- trait filter presentation

### What it controls

Per collection, specific trait keys can be treated as:

- `set`
- `range`

`set` traits render as the existing checkbox/value-list facet UI.

`range` traits render as:

- inclusive `from` input
- inclusive `to` input
- min/max numeric hint for the current page scope

### Effective configuration model

For this feature, each collection resolves:

- user-defined config
- optional extension-defined config
- selected source (`user` or `extension`)
- effective config

If no override exists, the sane default is:

- every trait behaves as `set`

### Scope rules

Range hints follow the same scope as the facet source:

- collection tokens: full collection
- collection activities: full collection
- holder-token page: owner-scoped subset

### Numeric behavior

Current v1 behavior supports only unsigned integers for range filtering.

If a range-configured trait contains non-numeric values:

- those values remain stored normally
- they are ignored for min/max computation
- they are ignored for range filtering

### Frontend surface

Collection shell now includes:

- `customization` tab
- extension-owned collection page tabs

The customization page currently exposes:

- trait filter presentation config
- token card trait summary template
- activity row trait summary template

Extension-defined values are read-only. User-defined values remain editable. If a user wants to start from the extension version and modify it, they must currently copy that configuration manually into the user-defined input.

## Trait Summary Template Overrides

Collection customization now also supports two template-driven presentation features:

- token card trait summary template
- activity row trait summary template

### What they control

Token cards can render one compact backend-provided summary string under the token id / price block.

Activity rows can render one compact backend-provided summary string in a dedicated `traits` column.

### Effective configuration model

Each feature resolves:

- user-defined template
- optional extension-defined template
- selected source (`user` or `extension`)
- effective template

Current default user-defined template for both features is:

- empty string

Empty string means no summary is rendered.

### Template behavior

The renderer is intentionally simple:

- literal text is emitted as-is
- `{TraitKey}` placeholders are replaced from token attributes
- missing placeholders render as empty strings
- `{{#if Trait}}text{{/if}}` renders `text` only when `Trait` has a non-empty value
- `{{#if Trait=Value}}text{{/if}}` renders `text` only when `Trait` exactly matches `Value`
- templates do not evaluate JavaScript or arbitrary expressions

Rendering is backend-owned so token browser cards and activity includes consume the same resolved summary behavior.

## Extension-Owned Collection Pages

The frontend collection-extension page contract lets bundled extensions contribute collection-scoped pages without giving those extensions privileged top-level routes.

Current frontend pieces:

- `frontend/src/lib/collection-extension-pages/` owns the page registry, generic page outlet, action scope, and page load helper.
- `frontend/src/lib/collection-extension-navigation.ts` supports activity-event targets and collection-extension page targets.
- Page tabs resolve only when the collection's enabled extension descriptors include the target extension and a frontend page registration exists.
- `frontend/src/lib/collection-navigation.ts` exposes `hrefs.extensionPage()`.
  Collection extension pages always carry `media_mode` and `media_preference`
  so visiting a non-media page cannot reset collection media intent;
  token-local `media_variant` and trait filters are not carried into static
  extension pages.
- Generic routes exist for standard collection pages and public single-collection deployments:
    - `/:chain_ref/:collection_ref/extensions/:extension_key/:page_ref`
    - `/extensions/:extension_key/:page_ref`
- Route load stays generic: it fetches collection context, checks the extension is enabled for that collection, and leaves page-specific behavior to the registered frontend extension page.
- Extension page registrations may provide an optional top-action component. That component renders inside the shared `CollectionPageLayout` action panel, and invokes page-body behavior through the page-local action scope rather than mutating the shared shell or hard-coding extension behavior in generic components.

The first bundled page contribution is Terraforms Hypercastle exploration.

## What Is Not Implemented Yet

The extension system is intentionally ahead of its current feature set in a few places.

### 1. Multiple enabled extensions per collection

Not supported yet.

Current system assumes a single enabled extension install per collection.

### 2. Arbitrary sync-time domain actions

Current sync hooks support metadata refresh enrichment and facts-only extension events. They do not yet support arbitrary stateful domain actions.

### 3. Remote or dynamically loaded extensions

Current system is build-bundled only.

### 4. Richer trait summary templating

Current trait summary templates support placeholder substitution plus constrained
conditional sections for presence and exact value checks.

Possible future work includes:

- richer compact summary variants
- additional safe templating helpers beyond direct placeholders and constrained conditionals
- activity-specific formatting behavior beyond a plain text summary column

## Recommended Reading

For the surrounding implementation details, use these docs together:

- `docs/indexer/00-overview.md`
- `docs/indexer/04-sync-pipeline.md`
- `docs/indexer/05-storage-and-schema.md`
- `docs/indexer/08-domain-metadata.md`
- `docs/indexer/12-ports-and-adapters.md`
- `docs/indexer/14-collection-bootstrap.md`
- `docs/ui/01-interaction-guidelines.md`
- `docs/backend-api.openapi.yaml`
