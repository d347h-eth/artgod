# Realized Price History

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
limits chart history to the configured chain.
`all` always uses `1d`; the shared policy also restricts any future range over
two years to daily buckets. The API normalizes the requested bucket, and the UI
keeps both its selector and URL consistent with that policy.

Eligible fills arrive through a SQLite iterator ordered by timestamp, block
number, log index, and row ID. Collection and token indexes provide that order
without a request-time sort. The backend domain computes OHLC, NFT volume, and
turnover in one pass with bigint prices. Buckets remain the inputs to technical indicators even though
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

## Data path and alpha scope

The chart targets one local collection with roughly 10,000–50,000 fills over five
years. The existing fills remain authoritative; no chart projection or persisted
bucket table is maintained.

1. Indexer decoding stores execution facts and original NFT price counts before
   tracking filters. Existing replay enriches eligibility; reorg rollback removes
   orphaned fills. The normal fills uniqueness constraint handles duplicate ingestion.
2. `SqlitePriceHistoryRead` applies collection/time/token, currency, and single-NFT
   eligibility filters. Migration 057 extends the collection and token time indexes
   with block/log ordering; SQLite row ID breaks remaining ties. The bounded
   iterator reads at most 100,001 eligible fills so overflow is explicit.
3. `GetPriceHistoryUseCase` validates through the domain, resolves scope, and
   streams the ordered reader into exact aggregation. No intermediate sort or
   copied SQL-row array is needed. HTTP adapters only translate request/response
   contracts; the composition root wires the concrete reader.
4. The chart page loads identity, navigation, and media settings through
   `GET /api/:chain_ref/:collection_ref/chart-context`. This avoids token-grid
   queries and trait-facet calculations. Sales have their own request and recovery.
5. The frontend expands the returned UTC bucket grid for the renderer and maps
   exact prices to floating-point coordinates. KLineCharts calculates enabled
   indicators. Drawing and hit testing visit visible buckets; the sidebar renders
   fifty rows. Media cards load separately through their bounded cache.

In `public_single_collection` mode with `BACKEND_QUERY_CACHE_PROVIDER=memory`,
the fills reader retains one collection snapshot, capped at 100,000 eligible
sales. Range, bucket, and token requests reuse it until expiry. The existing
`BACKEND_PUBLIC_COLLECTION_CACHE_REFRESH_MS` setting controls its TTL (default
30 seconds). Expiry reloads current SQLite facts, including historical changes
and deletions; there is no stale fallback or background refresh for this cache.
An oversized collection bypasses caching and can still serve bounded shorter
ranges. Desktop and cache-disabled deployments read SQLite directly. A manual
chart refresh during the public TTL may still return the cached snapshot.

Accepted alpha limits:

- Each request returns all eligible sales in its selected range and populated
  buckets. The browser replaces the response, clearing the selection. There is
  no pagination, incremental merge, or persisted browser history cache.
- SQLite row IDs identify dots within a loaded response. No new identity or
  revision protocol is needed while selections and results are replaced together.
- Daily long-history buckets keep five years to roughly 1,825 grid entries.
  The 100,000-fill and 30,000-bucket guards remain; they are explicit errors.
- Indicator initialization still depends on the requested range. Periods count
  populated buckets, and gaps stay blank. Pre-range warmup and recursive
  checkpoints are deferred.
- SQLite reads, aggregation, and serialization remain synchronous. The bounded
  alpha footprint does not justify a worker or persisted chart projection yet.
  Public traffic capacity and packaged-device performance are separate validation.
- No runtime synthetic-data generator is exposed. Synthetic data belongs only
  to maintained automated fixtures.

## Licensing and verification

The static frontend distributes KLineChart's Apache-2.0 license, NOTICE including
TradingView attribution, and bundled Lightweight Charts license in
`frontend/static/licenses/`. No paid service or runtime license server is used.

Relevant checks:

- `yarn workspace @artgod/backend test src/infra/collections/sqlite-price-history-read.test.ts src/domain/realized-price-history.test.ts`
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
browser history, daily all-history normalization, and 50,000-sale rendering with
bounded sidebar rows. Disposable SQLite coverage uses real migrations and 50,000
fills spread across five years, checks collection/token query plans for indexed
ordering without a temporary sort, and verifies public-cache expiry after new
fills, eligibility correction, and deletion. HTTP tests cover scope and compact
chart context; page-load tests reject accidental token-grid requests.

Screenshots stay under the active worktree's `tmp/runtime-recovery-playwright/`.
This is local synthetic database/API/browser evidence, not a packaged Tauri,
live-database, or public-load result.
