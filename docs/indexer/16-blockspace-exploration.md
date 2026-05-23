# Blockspace Exploration

This document describes the current blockspace exploration feature: the stable
block-range grid, stacked isometric levels, realtime UI refresh, selection and
backfill controls, and the public single-collection cache.

Some backend application modules still use `sync-backfill` in their internal
names because the feature grew out of the manual backfill surface. The public
route and UI name is `blockspace`.

## User-Facing Shape

Routes:

- standard userland: `/:chain_ref/blockspace`
- public single-collection web: `/blockspace`
- collection quick access: `/:chain_ref/blockspace?collection=:collection_slug`

Backend API routes:

- `GET /api/:chain_ref/blockspace`
- `GET /api/:chain_ref/blockspace/range`
- `POST /api/:chain_ref/blockspace/backfill`

Public single-collection mode registers only read routes for the configured
collection. The backfill route is not registered there, and the public UI keeps
the commit button disabled.

## Stable Range Model

The backend use case is
`backend/src/application/use-cases/sync-backfill/get-sync-backfill-state.ts`.

Each blockspace page has:

- `fromBlock`
- `toBlock`
- `bucketSize`
- `gridCellCount`
- `canDrillDown`
- a `grid` array of bucket cells
- anchored timestamp data for the page endpoints

The root page is organic: it spans chain genesis through the current head, so it
can have fewer than 1024 buckets at the top level. Deeper pages preserve stable
1024-multiple boundaries:

- one visible page contains up to 1024 buckets
- full pages render as 32 by 32 grids
- each drill-down divides the clicked bucket into the next 1024 buckets when
  `bucketSize > 1`
- the lowest level has `bucketSize = 1`, so each tile is one block

The frontend may visually reshape incomplete levels into the smallest square
that fits their bucket count, with padded disabled tiles. This is presentation
only; backend range math stays unchanged.

## Timestamp Anchors

Every page and explicit range summary resolves timestamps for its exact
`fromBlock` and `toBlock`.

Resolution order:

1. chain-level genesis timestamp override, when the requested endpoint is the
   configured genesis block
2. indexed `blocks` table timestamp
3. configured JSON-RPC block lookup
4. `unavailable` when neither DB nor RPC can supply the timestamp

Durations shown in the UI are based on those endpoint timestamps. Bucket
durations inside the page are derived from the anchored page duration rather than
from per-bucket RPC calls.

Ethereum's genesis timestamp override lives in the chain schema/seed data so the
UI does not inherit providers that return `0` for block `0`.

## Sync Coverage Data

Chain-wide sync coverage reads from indexed block data.

Collection-scoped coverage reads from `collection_sync_blocks`, which is updated
by backfill and realtime sync paths for live and bootstrapping collections. This
lets the UI show both completed collection coverage and ongoing bootstrap
coverage.

Each grid cell returns:

- block range
- total block count
- synced block count
- state: `empty`, `partial`, or `complete`
- drill-down permission
- optional collection deployment marker

When a selected collection has `deployment_block`, the UI marks the cell that
contains that block. Drill-down before deployment is blocked in the
single-collection public view so public users cannot spend requests exploring
irrelevant pre-deployment history.

## Frontend Rendering

Core frontend files:

- `frontend/src/routes/[chain_ref]/blockspace/+page.ts`
- `frontend/src/routes/blockspace/+page.ts`
- `frontend/src/lib/components/BlockspacePageView.svelte`
- `frontend/src/lib/components/BlockspaceIsometricGrid.svelte`
- `frontend/src/lib/blockspace-page-stack.ts`
- `frontend/src/lib/blockspace-isometric-levels.ts`
- `frontend/src/lib/blockspace-live-refresh.ts`

The isometric renderer shows the current navigable path, not the fully expanded
chain tree:

- root only on first load
- root plus selected child page when the URL stack points one level deeper
- root plus selected child plus leaf page when the URL stack points two levels
  deeper

The URL stack stores child pages as `page_start:bucket_size` entries. The route
load fetches the visible stack for hard loads and shared URLs. In-page
navigation uses shallow state changes and component-owned fetching so it can
reuse ancestor level state.

## Frontend State And Fetch Control

The fetch planner in `frontend/src/lib/blockspace-page-stack.ts` computes the
minimum page requests needed for a stack transition:

- keep already-loaded ancestor levels whose stack entries did not change
- fetch only the changed child suffix
- preserve a stable scroll anchor during transitions

The page component owns live refresh and post-action refreshes. It does not rely
on route invalidation for ordinary tile clicks.

Live refresh behavior:

- `frontend/src/lib/blockspace-live-refresh.ts`
- interval: `BLOCKSPACE_LIVE_POLL_INTERVAL_MS = 5000`
- skips overlapping refreshes
- refreshes currently visible level pages directly
- keeps selection state and right-side panels stable while fresh coverage data
  arrives

This keeps level 2 and level 3 updates smooth as new synced blocks appear.

## Interactions

Normal tile click in browse mode does two things:

- selects the tile and shows its range summary in the right-side panel for that
  level
- opens the child level when the tile is drillable

For `bucketSize = 1`, the same click shows a single-block summary. It does not
show a bucket chip.

Backfill selection mode:

- entered with the `backfill range` button
- escaped with the cancel button or `Escape`
- the user clicks a `from` tile and then a `to` tile on the same visible level
- `to` must be greater than or equal to `from`
- selected tiles are filled with the orange selection state
- the selected range summary appears beside the selected-bucket summary for that
  level
- commit schedules the selected range only in non-public deployments

Selection mode does not trigger normal browse-mode selected-tile highlighting or
drill-down behavior.

## Public Single-Collection Cache

The public cache is implemented by
`backend/src/infra/sync-backfill/public-collection-blockspace-cache.ts`.

It is enabled only when all of these are true:

- `PUBLIC_APP_DEPLOYMENT_MODE=public_single_collection`
- `PUBLIC_APP_CHAIN_REF` and `PUBLIC_APP_COLLECTION_REF` resolve to a collection
- `BACKEND_QUERY_CACHE_PROVIDER` is not `disabled`

The cache wraps the `SyncBackfillReadPort` used by the public blockspace read
use case. Standard desktop/userland blockspace reads continue to use the normal
repository path.

The cache is deliberately simple:

- it fully rebuilds a snapshot at startup
- it fully rebuilds again on `BACKEND_PUBLIC_BLOCKSPACE_CACHE_REFRESH_MS`
- it does not perform incremental mutation or fine-grained invalidation
- stale data is acceptable for public web because desktop/self-hosted users are
  the realtime-first path

The default refresh interval is 60 seconds.

### Snapshot Contents

The snapshot is scoped to one chain and one collection:

- collection id and slug
- effective range from deployment block, or `0` when deployment block is unknown
- current highest synced block
- total synced block count
- compact synced intervals as typed arrays
- prefix counts before each interval
- 1024-block bucket counts in a `Uint16Array`
- snapshot `storedAt`

It does not store one object per block.

The interval representation is built from `collection_sync_blocks` by grouping
contiguous synced block numbers into islands. For example, three dense spans
become three interval entries rather than thousands of block entries.

### Lookup Paths

The cache answers the `SyncBackfillReadPort` count methods:

- `countSyncedBlocks`
- `countSyncedBlocksInRange`
- `countSyncedBlocksByRange`

Aligned 1024-block ranges use the bucket-count array. This is the fast path for
level 1 to level 2 drill-down pages and most visible grid aggregation.

Arbitrary selected ranges and single-block lookups use binary search over the
interval arrays, then count overlap against the first and last touched
intervals. This makes selected range summaries precise without one DB query per
selection.

The cache does not own:

- collection option listing
- highest synced block lookup
- block timestamp lookup
- JSON-RPC fallback

Those calls still pass through the inner read/RPC ports. Cache headers therefore
describe query-cache coverage-count behavior, not every piece of data used by
the response.

### Cache Diagnostics

When the public cache serves a count from the snapshot, it marks the current
request as a cache hit and records age/ttl. When no snapshot is loaded yet, it
marks a miss and falls back to the inner repository. When the request is for a
different chain/context, it marks a bypass and falls back.

Response/debug surfaces:

- backend response headers:
  - `X-ArtGod-Query-Cache`
  - `X-ArtGod-Query-Cache-Age-Ms`
  - `X-ArtGod-Query-Cache-Ttl-Ms`
  - `X-ArtGod-Query-Cache-Events`
- backend Loki logs:
  - `component=BackendApi`
  - `action=query_cache_response`
- frontend SSR Loki logs:
  - `component=FrontendSSR`
  - `action=backend_api_response`
- page response headers in SSR:
  - aggregate cache state across all backend calls used by that page load

For the full SSR/backend observability path and focused tests, see
`docs/indexer/10-observability-and-metrics.md`.

## Tests

The normal workspace test suites include the blockspace and observability tests.
Focused commands for this feature:

```sh
yarn workspace @artgod/backend test src/application/use-cases/sync-backfill/get-sync-backfill-state.test.ts src/infra/sync-backfill/sqlite-sync-backfill-repository.test.ts src/infra/sync-backfill/public-collection-blockspace-cache.test.ts
yarn workspace @artgod/frontend test src/lib/blockspace-page-stack.test.ts src/lib/blockspace-isometric-levels.test.ts src/lib/blockspace-live-refresh.test.ts src/lib/blockspace-page-load.test.ts
yarn workspace @artgod/frontend check
yarn tsc -b
```

Focused commands for SSR/backend cache diagnostics:

```sh
yarn workspace @artgod/shared test observability/http.test.ts
yarn workspace @artgod/backend test src/http/common/observability.test.ts src/utils/query-cache-debug.test.ts
yarn workspace @artgod/frontend test src/lib/backend-api.test.ts src/lib/backend-api-browser.test.ts src/lib/query-cache-response-headers.test.ts src/lib/blockspace-page-load.test.ts
```

Runtime smoke check for Grafana/Loki ingestion after starting the observability
stack and triggering an SSR blockspace page:

```sh
./scripts/check-observability-log-ingestion.sh
```
