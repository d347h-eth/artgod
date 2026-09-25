# Realized Price History PoC

The fourth Explore tab, `chart`, opens the dedicated collection sale chart.
There is no chart link on token detail. Inline charts and line/candle display
modes have been removed. The chart plots individual
sales as dots and supports panning, zooming, fit, and configurable indicators.

The workspace fills the remaining viewport below collection navigation and its
compact toolbar. It uses a 90/10 chart/sidebar split on wide screens; the sidebar
keeps a 190px minimum for readable sale rows at smaller widths. Range and bucket
are URL state. Indicator settings and pinned selection reset on a full reload.

## Sales and selection

The sidebar normally shows the newest loaded sales first. Hovering a dot shows
all fills under that point and an ephemeral token-card popup. Leaving the dot
immediately removes the popup and restores recent sales. Clicking pins that sale
group, highlights its dots in the shared orange selection color, and pins its
card in place. The pinned card remains interactive: its token and marketplace
links retain native navigation, and its media opens the shared fullscreen
preview. Other hovers leave the pinned card and sidebar unchanged. A single left
click on empty chart space, the same dot group, or `unpin` releases both.
Dragging to pan never changes the pinned selection.

Right-aligned sidebar rows show relative time, a borderless 16px token image, the price in its original
currency, seller, and buyer. Time and price link to the configured transaction
explorer; time hover shows absolute UTC. Seller/buyer links open collection owner
pages. Token image hover opens the same ephemeral preview; clicking opens token
detail. Fifty rows render at a time, including large coincident-sale groups.

Seller/buyer roles follow the fill's order side: maker sells an ask and buys an
accepted offer. Unknown sides or participants stay unknown instead of creating
guessed ownership links.

Popups render the same `TokenCardTile.svelte` as the asks/tokens grid, with its
normal 400px media height, configured trait summary, and current ask link. They
add no border, caption, or scaling. Cards stay within the viewport; short
viewports can scroll the card without shrinking it. Unpinned cards take no
pointer or keyboard input and disappear on exit, even after a late response.
Pinned cards accept pointer and keyboard input.

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

- Multiple independently configurable SMA/EMA instances overlay the price pane.
- MACD defaults to 12/26/9. Its histogram is MACD minus signal.
- RSI defaults to 14.
- Volume bars count NFTs. The readout shows both the NFT count and exact ETH
  turnover for the same bucket, using the original integer sum. Empty buckets
  keep blank readouts; ETH/WETH/BETH remain normalized 1:1.
- Lengths count populated buckets; calculations use all loaded populated history,
  then restore blank gaps on the time grid. Panning does not alter the values.

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
explorer/owner/token links, reused interactive cards, stale card completion,
loading/empty/error/retry, token scope, browser history, and 50,000-sale rendering
with bounded sidebar rows. Screenshots stay under the active worktree's
`tmp/runtime-recovery-playwright/`. This is local synthetic browser evidence,
not a packaged Tauri or live SQLite performance result.
