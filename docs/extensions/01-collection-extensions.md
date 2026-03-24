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

Those watch specs can currently normalize only into collection-scoped metadata refresh events/ranges. They do not yet emit arbitrary new domain actions.

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

This means:

- canonical metadata can succeed even when extension refresh is delayed or failing
- backend presentation can converge later once artifacts exist

### 4. Backend presentation overrides

Backend resolves effective token presentation through an extension-aware read layer.

Today that includes:

- media mode resolution (`artifact` / `snapshot`)
- token card image override
- token detail image / animation override
- activity token include media override

Relevant backend pieces:

- `backend/src/application/collection-extensions/types.ts`
- `backend/src/application/collection-extensions/index.ts`
- `backend/src/infra/collections/extension-aware-collection-detail-read.ts`

The backend still returns one effective media set per token response. Extensions do not cause parallel media payloads to be emitted.

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
- stable artifact refs
- shared media mode keys
- extension-owned config parsing helpers

This file is the stable cross-runtime registry.

### Indexer layer

Indexer extensions currently own:

- sync watch specs
- artifact refresh logic

They do **not** currently own backend presentation logic directly.

### Backend layer

Backend extensions currently own:

- media modes exposed for a collection
- default media mode
- artifact ref resolution for a requested mode
- effective token card/detail projection
- extension-defined trait filter presentation config

This split keeps each runtime on its own contract instead of sharing a single cross-runtime implementation object.

## Blueprint Extension: Terraforms

The only existing embedded extension today is:

- `terraforms`

It should be treated as the blueprint implementation for the current extension system.

### What Terraforms currently demonstrates

1. Embedded install resolution by exact collection contract + token scope
2. Sync-time custom watch specs
3. Artifact refresh into `token_extension_artifacts`
4. Backend media override from artifact-backed token media
5. Extension-defined collection customization override

### Current Terraforms artifact usage

Terraforms caches version-2 media artifacts using:

- `extension_key = "terraforms"`
- `artifact_ref = "terraforms-v2-media"`

The backend can then resolve:

- `artifact` mode -> extension-backed effective media when artifact exists
- `snapshot` mode -> canonical media from base token metadata

### Current Terraforms customization override

Terraforms now also provides an example trait filter presentation override through the backend extension contract.

This is important because it demonstrates that extension-owned collection customization is not limited to media.

## Collection Trait Filter Presentation Override

The first collection customization feature implemented on top of the extension system is:

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

The first customization page currently exposes only:

- trait filter presentation config

Extension-defined values are read-only. User-defined values remain editable. If a user wants to start from the extension version and modify it, they must currently copy that configuration manually into the user-defined input.

## What Is Not Implemented Yet

The extension system is intentionally ahead of its current feature set in a few places.

### 1. Multiple enabled extensions per collection

Not supported yet.

Current system assumes a single enabled extension install per collection.

### 2. Arbitrary sync-time domain actions

Current sync hooks are limited to metadata refresh enrichment.

### 3. Remote or dynamically loaded extensions

Current system is build-bundled only.

### 4. Trait summary templates

Upcoming work will extend collection customization in a similar pattern for trait summary rendering.

Planned separate template-driven features:

- compact trait summary on token cards / token browser rows
- trait summary rendering on activity rows

The intended model is the same as trait filter presentation:

- user-defined config
- optional extension-defined override
- selected effective source per feature

Template syntax is expected to stay intentionally simple:

- placeholder substitution mixed with literal text

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
