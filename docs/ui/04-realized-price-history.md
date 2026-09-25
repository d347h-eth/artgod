# Realized Price History PoC

The fourth Explore tab, `chart`, opens the dedicated collection sale chart.
There is no chart link on token detail. Inline charts and line/candle display
modes have been removed. The chart plots individual
sales as dots and supports panning, zooming, fit, and configurable indicators.

The workspace fills the remaining viewport below collection navigation and its
compact toolbar. It uses a 90/10 chart/sidebar split on wide screens; the sidebar
keeps a 208px minimum for readable sale rows at smaller widths. Range and bucket
are URL state. Indicator settings and pinned selection reset on a full reload.

## Sales and selection

The sidebar normally shows the newest loaded sales first. Hovering a dot highlights
its group in the shared orange selection color and shows all fills under that
point and an ephemeral token-card popup. Leaving the dot removes the temporary
highlight and popup and restores recent sales. Clicking pins that sale group,
its highlight, and its card in place without remounting its media during the click.
The pinned card remains interactive: its token and marketplace links retain native
navigation, and its media opens the shared fullscreen preview. Other hovers
highlight their dots while leaving the pinned highlight, card, and sidebar
unchanged. A single left click on empty chart space, the same dot group, or `unpin`
releases both.
Dragging to pan never changes the pinned selection.

A single small upward arrow appears at the top center of the price pane when
sales within the current horizontal window are above the visible price range.
It updates during pan, zoom, and resize. Clicking it restores automatic price
scaling, like double-clicking the price-axis labels, and keeps the time window
and pinned selection. The arrow disappears when no higher sales remain offscreen.

Right-aligned, vertically centered sidebar rows show relative time, a borderless
16px token image, the price in its original currency, seller, and buyer. Time,
image, and price use content-sized columns with consistent spacing. The currency
uses a fixed-width `E`, `W`, or `B` label for ETH, WETH, or BETH, preserving the
vertical amount alignment. The hover text retains the full currency symbol.
Amounts round to at most three decimal places; price hover retains the exact amount.
Amount and currency share a baseline, with extra space before the seller column.
Time and price link to the configured transaction explorer; time hover shows
absolute UTC. Seller/buyer links open collection owner pages. Token image hover
opens its own ephemeral preview, including while a chart card is pinned, without
changing the pinned card or sales. This sidebar preview never pins; clicking the
image opens token detail. Fifty rows render at a time, including large
coincident-sale groups.

Seller/buyer roles and the sale action follow the fill's stored order side:
`sell` means `take-ask` (maker sells), and `buy` means `take-offer` (maker buys).
The API retains the action per sale; unknown sides produce a null action and
unknown participants instead of guessed ownership links. Dots and sidebar prices
use the same colors: take ask (cyan), take offer (pink), and unknown sides (sand).
Hovered and pinned dots use orange. Exact coordinate overlaps split the dot into
sectors for each observed action; the sectors identify types, not relative fill
counts. This describes the executed order side, not an inference about trader sentiment.

Popups render the same `TokenCardTile.svelte` as the asks/tokens grid, with its
normal 400px media height, configured trait summary, and current ask link. They
add no border, caption, or scaling. Cards stay within the viewport; short
viewports can scroll the card without shrinking it. Unpinned cards take no
pointer or keyboard input and disappear on exit, even after a late response.
Pinned cards accept pointer and keyboard input.
At phone widths a full-size pinned card can cover sidebar rows; those thumbnail
links remain reachable by keyboard, or after unpinning the card.

`GET /api/:chain_ref/:collection_ref/:token_ref/card` reuses the collection card
reader and effective trait template, including extension media preferences and
the public collection scope guard. Thumbnail and popup requests share a bounded
snapshot-card cache (256 tokens), at most four active requests and 100 queued
requests. Hover takes priority over queued thumbnails. Refresh clears the card
cache; navigation cancels requests. Failed requests can retry by hovering again
or with `retry` on a pinned card.

## Data contract

`GET /api/:chain_ref/:collection_ref/price-history` accepts `bucket`
(`1h`, `4h`, `1d`, `1w`), `range` (`30d`, `90d`, `1y`, `all`),
and optional `token_id`. Defaults are all stored history and daily buckets.
The endpoint follows the public collection scope guard. Runtime WETH configuration
limits this PoC to the configured chain.

Eligible fills are read through a SQLite iterator, sorted in memory by timestamp,
block number, log index, and stable identity. OHLC, NFT volume, and turnover use
bigint prices. Buckets remain the inputs to technical indicators even though
only individual sale dots are rendered.

Each sale retains its original currency address and symbol (ETH, WETH, or BETH);
all map 1:1 to ETH for coordinates and calculations. Other currencies are excluded.
Exact base-unit prices survive aggregation and hover; canvas coordinates and
indicators use floating-point ETH approximations.

Only quantity-one, single-NFT prices are eligible. Seaport executions must have
the original NFT count captured before tracking filters. Legacy Seaport fills
with unknown counts are excluded; legacy Blur V2 fills remain eligible because
their exchange price is token-specific. There is no automatic RPC replay. See
[fill decoding](../indexer/15-fill-decoding.md#single-token-price-eligibility).

All buckets use UTC; weeks start Monday. The response spans first through last
eligible sale buckets. Missing buckets remain blank, without interpolated or
carried prices. No sync-coverage classification is attempted. Unrealized prices
and open orders are out of scope.

Requests are capped at 100,000 eligible fills and 30,000 time buckets. Exceeding
either returns an actionable 400 response, never silent truncation. There is no
persisted candle projection, automatic refresh, or historical fetch pagination.

## Rendering and indicators

KLineChart 10.0.2 supplies canvas layout, axes, pointer interactions, resizable
indicator panes, and calculations. A custom drawing callback plots visible sale
dots with fractional bucket coordinates, preserving sub-bucket timestamps and
coincident fills. A spatial map provides hit testing without a DOM node per sale.
Missing internal OHLC values are NaNs, excluded from ranges and calculations.
Price-axis and price-crosshair labels show four decimal places. Only the axis
text formatter changes; sale values, coordinates, ranges, and indicator inputs
retain their existing precision.

- Multiple independently configurable SMA/EMA instances overlay the price pane.
- MACD defaults to 12/26/9. Its histogram is MACD minus signal.
- RSI defaults to 14.
- Volume bars count NFTs. The readout shows both the NFT count and exact ETH
  turnover for the same bucket, using the original integer sum. Empty buckets
  keep blank readouts; ETH/WETH/BETH remain normalized 1:1.
- Lengths count populated buckets; calculations use all loaded populated history,
  then restore blank gaps on the time grid. Panning does not alter the values.

## Interactive QA data

The chart toolbar accepts `test dots` (1–100,000) and a repeatable random `seed`.
`generate` replaces the displayed history with positive ETH prices following a
sine wave plus noise. Timestamps spread across the selected range; the selected
bucket controls OHLC, count, turnover, and indicator inputs. For `all`, a `years`
input supplies the duration (default three, maximum ten). The existing 30,000
bucket limit still applies; reduce the years/range or enlarge the bucket to
recover. Invalid submitted generator settings keep the current chart.

Changing range or bucket regenerates from the applied count, seed, and fixed
end time. Editing the inputs takes effect on `generate`. Generated rows are
labelled `generated`; they have no token media, ownership, or transaction links.
Hover, pinning, pagination, pan/zoom, and indicators use their normal chart path.
`stored sales` restores database-backed history for the current range and bucket.
A full page reload also restores stored sales.

Generation is browser-local and does not write to the database or make chart or
token-card requests. It exercises frontend preparation/rendering, not SQLite,
HTTP serialization, network transfer, or media loading performance.

## Current pipeline and internal production work

The implemented request path is:

1. Indexer fill decoding stores protocol facts in `fills`, with a unique
   chain/transaction/log/collection/token/kind identity. Explicit replay can
   enrich price eligibility; reorg rollback deletes orphaned fills.
2. `SqlitePriceHistoryRead` selects eligible fills for the collection and range.
   Migration 056 adds `(chain_id, collection_id, block_timestamp)` indexing.
   Its iterator limits returned rows, but the use case retains every accepted
   fill and the SQL does not request chronological ordering.
3. `GetPriceHistoryUseCase` calls `buildRealizedPriceHistory` synchronously in
   the request process. Each request sorts all accepted fills, aggregates exact
   OHLC/count/turnover, and returns every sale plus populated buckets as JSON.
4. The frontend expands the full returned UTC grid, including empty buckets,
   and loads it into KLineCharts. Each enabled indicator calculates over all
   loaded populated buckets. Drawing and hit testing visit only visible
   buckets; sidebar DOM is bounded to fifty rows. Token cards load separately.
5. Range/bucket changes and refresh repeat the full request and replacement.
   There is no projection cache, history cursor, or incremental update protocol.

Before treating multi-year history as production-ready, the internal work is:

- **Bound both sales and time span.** Provide explicit time windows and a stable
  chronological cursor for dots, with a bounded frontend cache and bucket
  loading. Never silently sample away individual sales. Five years of hourly
  buckets is about 43,800 entries and exceeds today's 30,000 limit even with
  very few sales. A larger response cap alone does not resolve this.
- **Define the sale read model once.** Preserve eligibility, original currency,
  exact prices, participants, and canonical execution ordering. Use a durable
  fill identity rather than the current SQLite row ID for cross-refresh cursors
  and selections. Verify query plans and timings on representative histories;
  an indexed ordered reader may suffice for thousands of sales. Persisted
  bucket projections are an optimization to justify with those measurements,
  not a prerequisite by themselves.
- **Make any projection/cache rebuildable and revision-aware.** Late backfills,
  replayed eligibility, new fills, and reorg deletion can all change old
  buckets. Recompute affected buckets (including open/close), publish data and
  progress atomically, and expose a consistent revision across dots and
  aggregates. Retain raw fills and test restart/retry/rebuild equivalence. An
  append-only high-water mark cannot represent these changes on its own.
- **Separate display range from calculation history.** Preserve the accepted
  empty-gap and populated-period semantics. Fetch complete boundary buckets
  and pre-range indicator warmup; define consistent initialization/checkpoints
  for recursive EMA/MACD/RSI. Today panning within loaded data is stable, but
  changing the requested range changes the initial input and can change the
  same indicator value at the same timestamp.
- **Bound request work and update cost.** Measure synchronous SQLite iteration,
  sorting, aggregation, JSON size/serialization, and browser parsing and
  calculation separately. Use bounded reads or a worker when measured work
  blocks the backend's event loop. Add revision-aware refresh/invalidation and
  incremental changes without resetting the user's viewport or selection.
- **Prove the whole path on disposable data.** Exercise multi-year sparse and
  dense histories, same-coordinate clusters, concurrent ingestion, backfill,
  duplicate replay, eligibility changes, and reorgs through real migrations,
  reader, HTTP, and browser. Measure latency, memory, long tasks and pan/hover
  responsiveness on the intended device. Generated browser dots alone cannot
  establish database or end-to-end readiness.

These are production follow-ups, not implemented projection or API guarantees.
They retain the PoC's currency, bundle, and missing-sale assumptions and do not
address public-hosting load.

## Licensing and verification

The static frontend distributes KLineChart's Apache-2.0 license, NOTICE including
TradingView attribution, and bundled Lightweight Charts license in
`frontend/static/licenses/`. No paid service or runtime license server is used.

Relevant checks:

- `yarn workspace @artgod/backend test src/infra/collections/sqlite-price-history-read.test.ts`
- `yarn workspace @artgod/backend test src/api.test.ts`
- `yarn workspace @artgod/frontend test src/lib/price-chart src/lib/collection-navigation.test.ts`
- `yarn workspace @artgod/frontend check`
- `yarn test:prices:history`
- `yarn build:userland`
- `yarn check:docs`

The maintained Playwright harness mounts production views with synthetic fills.
It covers navigation, layout, indicators, pan/zoom, pin/unpin, original currencies,
explorer/owner/token links, compact price formatting and alignment, uninterrupted
hover-to-pin media, order-side colors, price precision below the axis-label
resolution, independent sidebar previews alongside pinned cards, reused
interactive cards, stale card completion, loading/empty/error/retry, token scope,
browser history, and 50,000-sale rendering
with bounded sidebar rows. Generator coverage includes three-year histories,
100,000 dots, bucket/range changes, validation/recovery, and a late stored-data
response during generation. Screenshots stay under the active worktree's
`tmp/runtime-recovery-playwright/`. This is local synthetic browser evidence,
not a packaged Tauri or live SQLite performance result.
