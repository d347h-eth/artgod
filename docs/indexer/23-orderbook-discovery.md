# Orderbook discovery notes

These notes describe the system as it stood during discovery on local `main`
at `938ece5c`. The [worker and storage design](21-multiple-orderbooks.md)
describes the implementation.

## Requirements recorded on 25 November 2026

- Collection and token pages show one combined book of currency-priced listings
  and offers. The core projection ranks and publishes offers by what the seller
  receives after required fees. Keep the source of each price for later hints
  on a focused token card.
- VVV is an independent orderbook. Any tracked collection may match a market
  served by a venue. A collection extension does not select the venue.
- The two shared orderbook workers start with the indexer. They stay idle in
  an installation with no usable OpenSea key and no bound VVV market. The
  reconciler starts the browser only for VVV reads. OpenSea configuration
  changes take effect on composition restart.
  [Worker decisions and scope](21-multiple-orderbooks.md#run-two-shared-orderbook-workers)
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

- Both OpenSea reconcile entrypoints load the OpenSea config and require a key.
  The desktop supervisor also checks OpenSea enablement before spawning them.
  Renaming files alone would leave a keyless installation unable to read VVV.
  Development and Compose list the workers explicitly. The runtime registry
  documents how to keep launchers, built artifacts and observability in sync.
  [OpenSea config](../../indexer/src/config/opensea.ts) ·
  [Desktop supervisor](../../src-tauri/src/runtime/supervisor.rs) ·
  [Runtime registry](../desktop/02-runtime-registry-maintenance.md)
- At discovery time, the OpenSea bootstrap worker and reconciler called the same reader.
  Bootstrap also records identity, snapshot and readiness for the requesting
  run. The live-collection action can request a first read independently. The
  generic reconciler can take over both entry points. The existing sync worker
  demonstrates multiple bounded consumers in one Node process.
  [Bootstrap planner](../../backend/src/application/use-cases/bootstrap/bootstrap-pipeline-planner.ts)
  · [First-read handler after implementation](../../indexer/src/application/offchain/opensea-first-read.ts)
  · [Sync worker](../../indexer/src/runtime/sync-worker.ts)
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

Of the 4,563 missing listings, **283 still had time left** on their signatures
when the later book was read. An expiry timer would leave those listings in the
projection after VVV had dropped them. The other 4,280 listings and all 47
missing WETH offers were outside their signed windows by then. All 4,610
disappearances still change the recorded source membership.

I also joined the target NFT of each of the 122 later cash offers to the owner
in that same response. The reported counterparty matched the owner on 92 offers
and differed on 30. Six of the 20 marked fillable had a different counterparty.
This is why the adapter keeps that venue field separate from the signed token
target and from ArtGod’s ownership checks.

## Ordering and the last visible price

- On `main`, an OpenSea run can finish while normalized orders are still in
  JetStream. If run A saw an ID, run B omits it and the upsert from A is
  delivered last, comparing only rows already in `orders` can miss the removal.
  Track accepted membership at the source and carry its revision through
  dispatch. Record the removal even if A never got as far as validation. An
  empty response is enough to exercise this case.
  [Orderbook sync](../../indexer/src/application/offchain/opensea-orderbook-sync.ts)
  · [Dispatch](../../indexer/src/application/offchain/dispatch.ts)
- `SqliteOrderSourceStateStore` uses `NOT EXISTS` on seen IDs and rechecks
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

The existing reconciliation call applies removals before returning. The design
keeps that property even if JetStream is backed up. Only work such as admitting
new signed terms needs a queued hand-off. A durable source revision lets the
domain worker recognize late work. A market-wide read and each local collection
binding have independent revisions so purging one local scope cannot discard
another collection’s book.

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
  signed amounts. Current onchain fillability still needs runtime validation.
  [Seaport verification](../../indexer/src/application/offchain/seaport-protocol.ts)
- In the reference worktree, `tmp/vvv-orderbook-20261115/browser/transport-probe.cjs`
  made the same public orderbook request from a Chromium page, Playwright’s HTTP
  client and curl. The page received JSON with HTTP 200. Both direct clients
  received HTTP 429. The saved comparison is
  `tmp/vvv-orderbook-20261115/browser/transport-2026-11-16T00-01-49.893Z/results.json`.
  A second successful browser read is recorded in
  `tmp/vvv-orderbook-20261124/results.json`. Later, the packaged Linux
  worker passed scheduled reads and restart recovery with local responses.
  Its public request received HTTP 429. [Packaged verification](11-testing.md#packaged-orderbook-workers)
- Replayed the saved IDs through **the same SQLite source-state store OpenSea
  calls** on a disposable migrated database. Seeded the 5,047 earlier cash
  orders as source members with observation times outside the OpenSea stream
  guard, then supplied all 3,075 IDs from the later book. The store marked
  exactly the expected 4,610 IDs inactive. An identical second read removed
  zero. An independent source’s control order stayed active. This exercise
  tested the missing-ID comparison. It did not ingest new VVV orders.
- In a separate price fixture, two sources listed the same token for 0.8 and 1
  ETH. Withdrawing the cheaper source moved the existing current-ask selector
  and the seller’s daily row from 0.8 to 1 ETH. Withdrawing the last source
  returned no current ask. The historical daily row retained its last price of 1
  ETH. [Current asks](../../shared/database/current-asks.ts) ·
  [Daily seller prices](../../indexer/src/infra/storage/sqlite-daily-listing-prices.ts)
- Ran the current indexer reconciliation, retention, dispatch, daily listing and
  collection-scope tests against disposable local databases. All 66 tests
  passed. All 56 backend bid-book and cached collection-detail tests passed, as
  did all 49 shared collection-read and OpenSea bid-price tests. These exercise
  the existing OpenSea and local read paths. The multi-venue scenarios in the
  design are acceptance cases for implementation.
