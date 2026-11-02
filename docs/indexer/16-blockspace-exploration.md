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
- optional collection deployment and bootstrap-anchor markers

When a selected collection has `deployment_block`, the UI marks the cell that
contains that block with `❀`. Its bootstrap anchor is marked with `⫯` using the
same Mathcastles font and marker styling. Both markers remain visible when they
share a bucket, including when deployment and anchor are the same block. Their
synced state reflects coverage of each exact block, independently of the whole
bucket. Markers appear only for the selected collection; chain-wide views
continues to show indexed block coverage without collection markers.

New collection bootstraps discover a missing deployment block in an independent
optional step. The marker becomes available when that lookup finishes, including
after the collection becomes live. Supplied deployment hints are preserved.

Drill-down before deployment is blocked in the
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

`CachedGetPublicBlockspace` in the backend application layer owns demand and
response reuse. `SqlitePublicBlockspaceCoverage` owns the private coverage read;
`GetSyncBackfillStateUseCase` continues to own geometry, markers, totals,
validation, head fallback and timestamps.

The cache is enabled only for `public_single_collection` with a configured chain
and collection and a query-cache provider other than `disabled`. Standard
private/desktop reads use `SqliteSyncBackfillRepository` directly.

### Demand and Freshness

The first request loads the configured collection's full coverage. Concurrent
cold callers share that build. Construction, listener startup and idle time do
not load or refresh blockspace.

`BACKEND_PUBLIC_BLOCKSPACE_CACHE_REFRESH_MS` is the single freshness setting;
its default remains 60 seconds. Age starts when coverage finishes loading.
Hits and navigation do not reset it. Once it expires, the next request starts
one full rebuild while callers continue using the last successful generation.
There is no refresh timer. Restarting discards the in-memory cache.

A completed replacement swaps coverage and its response store together.
Temporary refresh failures retain the previous success; another demand can retry
after the same refresh interval measured from the last attempt. A missing or
ineligible collection retires cached success when detected. Later demand can
reload a restored or recreated collection at that same retry cadence.

Only requested pages and explicit range summaries are saved, including their
head/tip fields and timestamps. Root has its own identity; deeper pages use
`page_start` and `bucket_size`, and range summaries use their endpoints. Head
changes do not create new keys. A bucket size of 1 spans 1,024 blocks per page;
a bucket size of 1,024 spans 1,048,576 blocks per page.

The existing RPC head result, including failure and indexed fallback, is shared
within a generation. Endpoint timestamps retain the ordinary DB/RPC fallback;
a saved complete response reuses its resolved timestamps.

### Coherent Coverage and Representation

The reader opens a separate read-only SQLite connection with no native busy
wait, begins one read transaction, and resolves eligibility, collection identity,
metadata, indexed tip and membership within that view. It closes the connection
before returning copied coverage, also on cancellation or failure. No read
transaction stays open for the cache lifetime.

Coverage means exact unique membership in `collection_sync_blocks`. Each refresh
recounts the full canonical history, so historical gap fills, same-count moves,
rollback, retained-header resets and purge/recreation are detected without
indexer write hooks. Global headers and ownership snapshots do not establish
collection coverage. Public cached counts clip to deployment through indexed
tip; the raw private/disabled repository retains its existing predeployment
count behavior. `summary.syncedBlockCount` remains part of the response.

The reader counts at most 65,536 blocks per SQL step. A full count proves a dense
range; an empty count needs no extraction. Partial ranges read ordered members
in steps of at most 16,384 blocks. Explicit event-loop yields target four-ms work
turns, with a 30-second read budget. Native calls can exceed that turn target;
these bounds are tuning choices, not latency guarantees.

Consecutive members are stored as intervals with prefix counts. When interval
storage approaches bitmap cost, the same read view converts to one bit per
block, with prefix counts every 1,024 blocks. Conversion and prefix construction
also yield. Arbitrary inclusive ranges and markers remain exact across both
representations. Each rebuild chooses its representation anew, including after
coverage is cleared. Numeric storage uses bounded intervals and a bitmap capped
at 32 MiB, plus its prefix array.

### Admission, Shutdown and Errors

One build serves the configured scope. The current generation retains at most
64 complete responses. The cache admits at most 64 concurrent requests and permits at most eight
distinct response builds across current and replaced generations. Matching
in-flight response requests coalesce; overload rejects without an unbounded
work queue. Refresh waits while response admission is saturated, bounding work
behind slow foreign RPC calls while saved responses remain available.

Fastify's `preClose` stops admission and cancels owned SQLite reads before
waiting for active requests. Late work cannot publish cache entries after
shutdown. Foreign RPC calls keep their existing timeout contract; shutdown
releases HTTP callers without waiting for those calls.

Existing parsing, route guards and validation errors remain in their HTTP
adapters. Operational cold-load failure, overload and shutdown return 503 with
`blockspace_unavailable` and an actionable retry message. Missing scope returns 404. An invalid page or range does not retire valid scope coverage.

### Cache Diagnostics

A saved complete response marks a hit; building a requested response marks a
miss. Hit age measures time since the coverage generation was published,
including when stale success is served. A miss reports age zero under the shared
diagnostic contract. TTL always reports the configured refresh interval; these
headers do not create a separate response freshness clock. The query-cache
storage and debug contracts are shared with other backend caches.

Response/debug surfaces:

- backend headers: `X-ArtGod-Query-Cache`, `X-ArtGod-Query-Cache-Age-Ms`,
  `X-ArtGod-Query-Cache-Ttl-Ms`, and `X-ArtGod-Query-Cache-Events`
- backend logs: `component=BackendApi`, `action=query_cache_response`
- SSR logs: `component=FrontendSSR`, `action=backend_api_response`
- SSR page headers: aggregate cache state across the backend calls in that load

See [observability](10-observability-and-metrics.md) for the shared diagnostic
path and its focused tests.
