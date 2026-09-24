# Realized Price History PoC

The collection browser and token detail view share `RealizedPriceChart.svelte`.
The user can inspect individual sale dots, bucket-close lines, or OHLC candles;
pan, zoom, fit the loaded history, and toggle/configure indicators. Range,
bucket, and mode are URL state. Indicator settings are local to the mounted
chart; they reset on a full reload.

## Data contract

`GET /api/:chain_ref/:collection_ref/price-history` accepts `bucket`
(`1h`, `4h`, `1d`, `1w`), `range` (`30d`, `90d`, `1y`, `all`),
and optional `token_id`. Defaults are all stored history and daily buckets.
The endpoint follows the usual public collection scope guard. Runtime WETH
configuration limits this PoC to the configured chain.

The use case reads eligible fills through a SQLite iterator, sorts in memory
by timestamp, block number, log index, and stable fill identity, then computes
OHLC, NFT volume and turnover with bigint prices. Its response includes raw
sales for dots and populated buckets for all three modes. Each sale retains its
original `currencyAddress` and `currencySymbol` (ETH, WETH, or BETH); each maps
1:1 to ETH for chart coordinates, OHLC, and indicators. Dot hover shows the
exact price in the original currency. Other currencies are excluded.

Only quantity-one, single-NFT prices are eligible. Seaport executions must have
the original NFT count captured before tracking filters. Legacy Seaport fills
with unknown counts are excluded, even if only one sibling row exists. Legacy
Blur V2 fills remain eligible because each exchange already has a token-specific
price. This deliberately reduces historical coverage until an explicit replay;
there is no automatic RPC fetch or replay. See
[fill decoding](../indexer/15-fill-decoding.md#single-token-price-eligibility).

All buckets use UTC; weekly buckets start Monday. The response spans the first
through last eligible sale bucket. Missing interior buckets stay blank: no price
interpolation, carried close, or fake zero candle. No separate sync-coverage
classification is attempted. Open orders and unrealized prices are out of scope.

Requests are capped at 100,000 eligible fills and 30,000 time buckets. Exceeding
either returns an actionable 400 response, never a silently truncated chart.
The date index narrows collection reads. There is no persisted candle projection,
automatic refresh, or historical pagination in this PoC.

## Rendering and indicators

KLineChart 10.0.2 supplies canvas layout, axes, pointer pan/zoom, resizable panes
and indicator calculations. It is pinned because it satisfies the repository's
30-day dependency age policy.

The native price layer assumes dense numeric candles and can join missing
points. A custom indicator drawing callback therefore renders prices while
the adapter expands an evenly spaced bucket grid. Missing prices are internal
NaNs, excluded from price ranges and indicator calculations. No library source
is patched. Only visible buckets and their sale dots are drawn. A spatial map
supports hover lookup without one DOM element or overlay per sale.

Dots use fractional bucket coordinates so individual timestamps are retained.
Fills at identical time/price coordinates remain distinct; hover lists their
identities, with pages of ten for large overlap groups. Line mode breaks at gaps
and marks isolated closes. Candle mode uses each bucket's open, high, low and
close. The time grid and indicator inputs stay the same in every mode.

- SMA uses KLineChart's arithmetic `MA` calculation; EMA uses `EMA`.
  Multiple independent instances have configurable lengths.
- MACD defaults to 12/26/9 and exposes all three lengths. KLineChart's doubled
  histogram is divided by two to show MACD minus signal.
- RSI defaults to 14 with configurable length.
- Volume counts NFTs sold, not ETH turnover.
- All lengths count **populated buckets**. Calculations run on all loaded
  populated history, then results are mapped back to the original time grid.
  Gaps and warmup remain blank. Panning does not change indicator values.

Prices stay exact base-unit strings through aggregation and hover inspection.
The canvas and indicators use floating-point ETH values. This is a charting
approximation, not an execution-price calculation.

## License distribution

KLineChart is Apache-2.0. The static frontend assets include its license, NOTICE
(including the TradingView attribution), and bundled Lightweight Charts license:

- `frontend/static/licenses/klinecharts-LICENSE.txt`
- `frontend/static/licenses/klinecharts-NOTICE.txt`
- `frontend/static/licenses/klinecharts-lightweight-charts-LICENSE.txt`

They are included in frontend build output under `/licenses/`. No runtime
license server or paid chart service is used.

## Verification

- `yarn workspace @artgod/indexer test tests/fill-price-nft-count.test.ts tests/decode-fill-fixtures.test.ts tests/decode-seaport-fills.test.ts`
- `yarn workspace @artgod/backend test src/infra/collections/sqlite-price-history-read.test.ts src/api.test.ts`
- `yarn workspace @artgod/frontend test src/lib/price-chart/model.test.ts`
- `yarn workspace @artgod/frontend check`
- `yarn test:prices:history`
- `yarn build:userland`
- `yarn check:docs`

The maintained Playwright harness mounts the production collection and token
views with synthetic price responses. It covers display modes, indicators,
pan/zoom, bucket requests, loading/empty/error/retry, dot hover and browser history.
It also renders a 50,000-sale fixture and checks zoom plus pagination through
coincident dots; the attached load-to-render timing is synthetic browser evidence,
not a frame-rate guarantee or a live SQLite benchmark.
Its screenshots are retained under the active worktree's
`tmp/runtime-recovery-playwright/` for rendered review. This does not establish
packaged Tauri or live database performance.
