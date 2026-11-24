# Orderbook discovery notes

These notes record the requirements and evidence behind the proposed
multi-orderbook design. The code reference is local `main` at `938ece5c`.

## Requirements recorded on 25 November 2026

- Collection and token pages show one combined book of currency-priced listings
  and offers. Keep the source of each price so a later hint on a focused token
  card can explain differences between marketplaces.
- VVV is an independent orderbook. Any tracked collection may match a market
  served by a venue. A collection extension does not select the venue.
- A previously seen order missing from the next successful read of the same book
  is a removal. Record that individual change and apply it to the projection.
  The same rule applies to OpenSea and VVV.
- NFT-for-NFT offers, including trades with an ETH or WETH payment, are deferred
  barter. The current job is ingestion and projection of cash orders.
- The bidding bot reads OpenSea. When the existing bid-book selector chooses its
  snapshot, the UI shows that snapshot, including an empty one.

## Existing reconciliation

OpenSea walks listings and offers, records each ID in SQLite and publishes the
raw order to the offchain queue. When the read succeeds, it compares the IDs
with active local orders. The source-state store marks eligible missing orders
inactive in batches. It refreshes today's existing seller price in the same
transaction. A newer stream observation can protect an order from an older REST
read. Repository tests cover a failed fetch, an intervening observation, a
collection purge, and rollback if refreshing the price fails.
[Snapshot reader](../../indexer/src/application/offchain/opensea-orderbook-sync.ts)
·
[SQLite comparison](../../indexer/src/infra/offchain/sqlite-order-source-state.ts)
·
[Reconciliation tests](../../indexer/tests/opensea-orderbook-retention.test.ts)

## Follow an order from the marketplace to the screen

1. **Find the book.** OpenSea verifies a collection slug against a contract and
   sample token. Its reader walks listings and offers through the last page.
   Stream subscriptions use the persisted slug. ArtGod separately resolves a
   token to a local collection using its chain, contract and declared token set.
   The resolver requires one matching local scope. A marketplace can therefore
   cover several local collections on one contract.
   [Slug probe](../../backend/src/application/use-cases/bootstrap/probe-opensea-collection-slug.ts)
   · [REST reader](../../indexer/src/infra/offchain/opensea-api.ts) ·
   [Stream worker](../../indexer/src/runtime/opensea-stream-worker.ts) ·
   [Local scope resolver](../../indexer/src/infra/collections/sqlite.ts)
2. **Read the terms.** The offchain worker consumes raw JetStream jobs. Dispatch
   normalizes orders, resolves token-set membership and sends upserts to the
   order worker. OpenSea's REST and stream buys share one price and criteria
   parser. Its stream also reports cancellation, invalidation, revalidation and
   sale events. A completed OpenSea read can still have queued upserts and
   pending validation. This matters if an older upsert arrives after the next
   read removed the order.
   [Dispatch](../../indexer/src/application/offchain/dispatch.ts) ·
   [OpenSea buy terms](../../indexer/src/application/offchain/opensea-bidding-order-terms.ts)
   ·
   [Stream updates](../../indexer/src/application/offchain/opensea-normalize.ts)
   · [Completion semantics](00-overview.md#eventual-consistency-notes)
3. **Store the order.** Today `orders.id` is the primary key and
   `ON CONFLICT(id)` updates one source and one source status. Two venues
   publishing the same order would overwrite each other's evidence. A validation
   job references the order ID. Retired orders and the last successful
   collection observation also have keys that assume one venue.
   [Orders schema](../../database/migrations/003_orders_schema.sql) ·
   [Order writer](../../indexer/src/infra/domain/orders.ts) ·
   [Validation demand](../../database/migrations/058_order_validation_demand.sql)
   ·
   [Retention keys](../../database/migrations/055_market_data_storage_lifecycle.sql)
4. **Read a price.** Token cards, listed sorting and daily seller prices share a
   cheapest-ask query. It checks source status, fillability, currency and the
   validity window. The collection bidding view currently builds an OpenSea link
   from the token even when all it has is price and currency. The bid-book price
   cell also labels every market order hash as OpenSea. The combined book must
   carry enough information to avoid attributing a VVV price or order to
   OpenSea. [Current asks](../../shared/database/current-asks.ts) ·
   [Collection reads](../../shared/read-models/collections.ts) ·
   [Bidding view](../../frontend/src/lib/components/CollectionBiddingView.svelte)
   · [Price cell](../../frontend/src/lib/components/BidBookPriceCell.svelte)
5. **Select the bid book.** Both bid-book routes use the backend selector.
   Enabled jobs, a fresh running heartbeat and a fresh bot snapshot select the
   bot's OpenSea rows. Otherwise the backend reads the indexed orders. Bidder
   decisions use direct OpenSea data. The passive SQL also uses a
   collection-wide observation time that would let one venue appear to refresh
   another.
   [Bid-book repository](../../backend/src/infra/trading/sqlite-bidding-bid-book-repository.ts)
   ·
   [Trading read contract](../trading/03-market-data-and-scaling.md#bid-book-display-selection)

## Other callers affected by adding a second venue

- A bootstrap run currently schedules three OpenSea steps only when OpenSea is
  enabled and a slug exists. The reconcile scheduler loads OpenSea configuration
  and asks the collection registry for OpenSea candidates. General market
  discovery belongs alongside those bootstrap and scheduler owners. OpenSea
  stream controls and optional collection-extension steps have their own scope.
  [Bootstrap planner](../../backend/src/application/use-cases/bootstrap/bootstrap-pipeline-planner.ts)
  ·
  [Reconcile scheduler](../../indexer/src/runtime/opensea-reconcile-scheduler-worker.ts)
- Raw queue envelopes require a local collection ID. Dispatch builds the order
  upsert job ID from chain, order ID and receipt time. Two venues can publish
  the same hash in the same millisecond, and one remote book can cover two local
  collections. Carry the market and its revision all the way into the writer.
  The existing SQLite queue outbox already stores a required follow-up
  atomically with domain state and retries publication by unique job ID.
  [Raw job contract](../../indexer/src/domain/offchain-jobs.ts) ·
  [Dispatch](../../indexer/src/application/offchain/dispatch.ts) ·
  [Queue outbox](05-storage-and-schema.md#metadata-refresh-follow-ups-and-queue-outbox)
- The token browser, sale preview and collection bidding cards all build OpenSea
  links for current asks. The bid-book tooltip also names OpenSea for indexer
  data. Route links on aggregated prices through the winning publication or
  local token detail. Public deployment already restricts both bid-book routes
  to its configured collection and omits private bidding context.
  [Token browser](../../frontend/src/lib/components/TokenBrowserView.svelte) ·
  [Sale preview](../../frontend/src/lib/components/SaleCardPreview.svelte) ·
  [Feed label](../../frontend/src/lib/bidding-bid-book-source.ts) ·
  [Public read scope](../backend/02-http-security-and-deployment-modes.md#public-single-collection-mode)

## Two saved VVV books

I compared the public responses saved on 15 and 24 November. Both identify the
same chain and contract. I classified each order by what the maker offers and
what the maker requests, then compared the order hashes with both set
differences and SQLite joins.

| Supported orders | 15 Nov | Missing on 24 Nov | First seen in the later file | In both | 24 Nov |
| ---------------- | -----: | ----------------: | ---------------------------: | ------: | -----: |
| Listings         |  5,000 |             4,563 |                        2,516 |     437 |  2,953 |
| WETH offers      |     47 |                47 |                          122 |       0 |    122 |

VVV changed its reported fillability on 44 of the 437 common listings. These are
differences between the two saved responses. Orders could have come and gone
between them. Presence, availability and the reason an order left the book are
distinct facts.

## Ordering and the last visible price

- On `main`, an OpenSea run can finish while normalized orders are still in
  JetStream. If run A saw an ID, run B omits it and the upsert from A is
  delivered last, comparing only rows already in `orders` can miss the removal.
  Track accepted membership at the source and carry its revision through
  dispatch. Record the removal even if A never got as far as validation. An
  empty response is enough to exercise this case.
  [Orderbook sync](../../indexer/src/application/offchain/opensea-orderbook-sync.ts)
  · [Dispatch](../../indexer/src/application/offchain/dispatch.ts)
- `SqliteOrderSourceState` uses `NOT EXISTS` on seen IDs and rechecks
  eligibility at each write. A time allowance protects newer or coalesced
  observations from the OpenSea stream. VVV’s two ordered reads of the public
  book have no competing stream. They can show an order’s arrival and removal
  seconds apart.
  [Reconciliation store](../../indexer/src/infra/offchain/sqlite-order-source-state.ts)
  ·
  [Source-state tests](../../indexer/tests/opensea-orderbook-retention.test.ts)
- A successful source read and a change to the price shown to a user need
  different clocks. One marketplace can refresh successfully while another is
  unavailable. A removal can change a cached page after the newest surviving
  order was last observed. The design records when each market was read and
  advances the affected collection’s market revision when a change is applied.
  [Indexed bid-book read](../../backend/src/infra/trading/sqlite-bidding-bid-book-repository.ts)
  ·
  [Cached collection detail](../../backend/src/application/use-cases/collections/cached-get-collection-detail.ts)

## Checks completed on 25 November

- Re-read the two saved public responses in `feature/vvv-orderbook-access`. The
  files are `tmp/vvv-orderbook-20261115/browser/state-orders-051.json` and
  `tmp/vvv-orderbook-20261124/state-orders.json` in that worktree. Their SHA-256
  digests are `4cbdfc3ed74a117336ace1b8db1ac971b620d15130add3fc1e4f200d75e4471c`
  and `ff890ff37693fb3f020e8377c9a1cd88792874a6841a9ec6bb46a2cb31ad1c65`,
  respectively. The books give Ethereum block numbers 26,423,067 and 26,486,617.
- Used ArtGod’s Seaport code locally on every order in the later response. Its
  computed hash matched each of the 3,196 distinct published hashes. Signature
  recovery matched the signed maker and the venue’s maker on all 3,196,
  including 2,452 bulk signatures. Recomputed the two fee examples from the
  signed amounts.
  [Seaport verification](../../indexer/src/application/offchain/seaport-protocol.ts)
- The saved network results show an anonymous browser received JSON with HTTP
  200 on 16 and 24 November. On 16 November, ordinary HTTP clients received
  HTTP 429. The captures exercise the read. Repeated refreshes by a packaged
  ArtGod worker and current onchain fillability still need runtime tests.
- Ran the current indexer reconciliation, retention, dispatch, daily listing and
  collection-scope tests against disposable local databases. All 66 tests
  passed. Ran the backend bid-book and cached collection-detail suites. All 56
  tests passed. These exercise the existing OpenSea and local read paths. The
  multi-venue scenarios in the design are acceptance cases for implementation.
