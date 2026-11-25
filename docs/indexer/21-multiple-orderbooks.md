# Multiple orderbooks in ArtGod

**Proposed design.** Collection and token pages show one local book of
currency-priced listings and offers from all matching marketplaces. If VVV
withdraws a 0.8 ETH listing and OpenSea still offers the token for 1 ETH, the
card shows 1 ETH as soon as ArtGod publishes that refresh. The bidding bot and
its selected bid-book snapshot use OpenSea.

The alpha cutover resets SQLite and the queues, then rebuilds the book with a
fresh bootstrap.

```mermaid
flowchart LR
    OS[OpenSea public book and stream] --> Sync[Indexer reconciliation]
    VVV[VVV public book] --> Sync
    Sync --> Orders[Order domain evaluates quotes]
    Orders --> Local[(Local listings and offers)]
    Local --> Listings[Token cards and listing prices]
    Local --> Select{Bid-book selection}
    Bot[OpenSea bot snapshot] --> Select
    Select --> Offers[Collection and token offers]
```

## Build on the OpenSea path

OpenSea bootstrap and periodic reconciliation already share a reader. It records
the IDs returned across listings and offers, compares them with active local
orders after the last page, and protects newer stream observations. Today it
applies missing orders in batches visible to readers and refreshes a seller’s
existing daily price inside each batch. Keep the reader, set comparison and
orders domain. Change the point at which a completed book becomes visible.
[OpenSea reader](../../indexer/src/application/offchain/opensea-orderbook-sync.ts)
·
[SQLite comparison](../../indexer/src/infra/offchain/sqlite-order-source-state.ts)

Each venue adapter finds markets, declares what its feeds cover, and translates
their records. The indexer gathers that evidence. The order domain evaluates it,
applies settlement facts and publishes the combined projection in SQLite. The
backend serves the local projection, including offline. The browser uses the
existing collection and token routes. [Worker ownership](00-overview.md) ·
[Order processing](07-domain-orders.md)

## Map a market to tracked assets

- Register each venue once in the indexer composition root. When a collection is
  added or its scope changes, ask each enabled adapter for markets covering its
  chain and contract. Use the venue’s catalog or a verified configured
  reference. If the venue is temporarily unavailable, retry its lookup
  independently. Its adapter verifies each match against the public chain and
  NFT contract it serves. OpenSea can use its existing slug probe. VVV can start
  with the verified market entry in its adapter. A display name or ArtGod
  collection slug alone cannot identify a remote book. Record a verified binding
  and its revision independently of the outcome of the last refresh.
  [OpenSea slug probe](../../backend/src/application/use-cases/bootstrap/probe-opensea-collection-slug.ts)
  ·
  [VVV market evidence](22-vvv-orderbook-adapter.md#find-and-read-a-vvv-market)
- Allow several markets to cover one local collection and one market to cover
  several local collections. Schedule each distinct public book once. Route each
  exact token by chain, contract and token ID through
  `resolveTokenScopedCollectionId`. It understands token zero, ranges and
  explicit lists. If one market covers IDs 0–999 and the local collections split
  at 500, an ask for #700 belongs to the second collection. An ambiguous or
  untracked token can be reconsidered after the local scope changes.
  [Collection scope](../../shared/collections/token-scope.ts) ·
  [SQLite scope resolver](../../indexer/src/infra/collections/sqlite.ts)
- Keep the signed target and the venue’s description of a collection or trait
  offer. Use the existing token-set membership and mismatch handling before
  attributing it to a local collection or token. A wildcard for a whole
  contract, a venue collection on part of that contract and a signed criteria
  root each cover different assets. Removing a binding or purging one collection
  drops its local association and rejects delayed work for that association.
  Another collection using that market keeps its association. When a new local
  scope joins an already indexed market, match the current publications to it as
  part of setup. Stop polling when the last enabled association is removed.
  [Token-set materialization](07-domain-orders.md#token-set-materialization)
- Have the bootstrap planner schedule the first read for each verified market.
  The periodic scheduler then uses each market’s last successful run to decide
  when it is due. Today both paths select OpenSea by collection slug. Generalize
  that selection and the worker configuration so a VVV-only collection can sync
  with OpenSea disabled and without a collection extension. OpenSea still owns
  its API key, slug and stream toggle.
  [Bootstrap planner](../../backend/src/application/use-cases/bootstrap/bootstrap-pipeline-planner.ts)
  ·
  [Reconcile scheduler](../../indexer/src/runtime/opensea-reconcile-scheduler-worker.ts)

## Identify the feed, placement, signed order and quote

- **Feed.** Record who supplied the evidence, its chain, market, view or
  partition, and its run or event position. Two feeds can report the same
  listing. Keep the observation time and the feed’s authority with each report.
- **Venue placement.** Identify the publication by publishing venue, chain,
  remote market and venue-native order ID. Store its presence, venue status,
  reported fillability, audience and revision. A feed relaying a VVV listing can
  corroborate that placement. It creates a separate placement only if there is
  evidence another venue actually published the order there.
- **Protocol order.** For Seaport, verify the signed components against the
  public chain ID, verifying contract and order hash. Namespace that identity by
  protocol. One verified order owns its maker, signed criteria, validity,
  settlement state and remaining quantity. It has one validation demand across
  all placements. Keep an identifiable record with incomplete signing evidence
  attached to its feed and placement until it can be verified. Matching maker,
  token, price or a bare hash is insufficient to merge orders.
  [Seaport verification](../../indexer/src/application/offchain/seaport-protocol.ts)
  ·
  [Validation ownership](07-domain-orders.md#processing-ownership-and-retained-state)
- **Quote and route.** A route identifies where and on what terms a buyer or
  seller can use a placement. Bind the price to its settlement order, placement,
  currency, fill quantity, fees, audience and verified destination. A route may
  narrow the signed criteria or the quantity it offers. Relaying the order
  cannot add units or broaden its token criteria. Several eligible routes can
  offer the same units. Count that order and its available quantity once.

A VVV withdrawal ends the VVV placement’s contribution. A relay that later
repeats the old listing cannot revive it. An independent OpenSea placement for
the same signed order can still supply a quote. An offchain cancellation applies
to its exact placement. Confirmed protocol cancellation or full fill closes the
order across all placements. For a partial fill, every route draws from the same
proven remaining quantity. On a chain reorganization, revalidate the affected
settlement facts and keep independent venue evidence.
[Order lifecycle](07-domain-orders.md) · [Reorg handling](06-reorg-handling.md)

## Apply each book change

The adapter declares what a successful read can establish before the indexer
uses a missing ID as evidence.

- **Complete snapshot.** Replace the membership of the declared book. OpenSea
  completes its public listings and offers traversal after the final page
  succeeds. VVV’s public `orders` array is the returned book for its verified
  market. Compare every successful VVV read with its predecessor, even if it is
  shorter, the same size with different IDs, or empty. An empty array removes
  every prior member of that returned book. Whether VVV also hosts orders
  outside this view does not delay those removals.
- **Bounded window.** Identify the window by its actual boundary, such as a
  fixed top-N query for one side of a market. Replace membership within that
  view. An order leaving the window loses the contribution that came from it. A
  separate current observation can still support the order elsewhere. A page of
  an unfinished snapshot cannot replace a window or a book.
- **Sequenced feed.** Persist the last consecutive event position. Ignore
  duplicates. If a position is missing, hold later events for replay within the
  feed’s recovery limits. Freeze the feed’s accepted position and freshness
  until replay fills the gap, or establish a new snapshot with a known position
  and resume from there. For sources without a sequence, use the ordering the
  adapter can substantiate. In particular, preserve OpenSea’s guard for stream
  observations newer than an overlapping REST crawl.
- **Search or individual sighting.** Add or update the identified records. A
  subsequent search can return different matches without withdrawing the earlier
  placements. A wallet-specific view has its own scope. When feeds overlap,
  apply explicit withdrawals from the publishing venue to that placement and
  keep independently supported placements eligible.

For each accepted replacement record every **addition, change and removal** by
scoped native ID and run. Compare membership even for an order that is
unfillable or still queued. Compare the normalized fields that affect the quote,
including status, `fillable`, fees and audience. A change to `fillable = false`
withdraws that placement’s quote while its ID stays present. If the ID later
disappears, record a separate removal. In the two saved VVV books, all 44
surviving listings whose `fillable` flag changed had identical source
`updatedAt` values across the two reads. An identical repeated observation
advances last-seen time without duplicating a change. A withdrawn order that
later reappears gets a new addition, subject to any terminal settlement
evidence.
[VVV capture comparison](23-orderbook-discovery.md#two-saved-vvv-books)

A timeout, HTTP challenge, missing `orders` array, wrong market, unreadable
identity or failed page leaves the last accepted book in place. An identified
row with invalid signed terms can be recorded as present and ineligible. Record
the failure separately from the last successful read. Retain last-seen data for
offline browsing and expose the age of the evidence behind each price. A new
search dates only the records it returned. A new snapshot dates the membership
it actually covers. Signed expiry, chain changes and the freshness policy still
govern which routes may supply a current price. One venue’s success cannot make
another venue’s quote recent.

## Publish one complete refresh

A generation is one accepted version of a feed’s book. SQLite readers must see
either the preceding generation or its complete replacement. This matters for
permanent history as well as for the current price.

1. Read one replacement at a time per feed scope. Stage IDs, normalized terms
   and changes privately in bounded SQLite batches, tagged with the run number
   and remote market definition. Compare against accepted feed membership,
   including IDs whose order upsert is pending. Carry source event time and
   local receipt time separately. Preserve each distinct change even when
   another placement keeps the aggregate price the same.
2. Prepare the final eligible routes and the affected collection prices against
   this candidate generation **and all other active feeds**. Reuse current order
   validation where available. A new order awaiting required evidence can be
   present while validation is pending. Its eventual result is a separate
   change. Compare the candidate against newer stream events at publication,
   including orders first seen on the OpenSea stream. A stream sighting can
   supersede an older snapshot difference for the current quote while the
   difference remains recorded.
3. Derive today’s price **once per affected seller, token and collection** from
   the final eligible set. If this seller has another comparable ask, update the
   existing daily activity row to the lowest surviving buyer cost in that
   currency and quantity. Otherwise keep its last published price and currency.
   The token becomes unlisted when no seller has an eligible ask left. A
   withdrawal creates no activity row. The audit exercised the current
   daily-price writer with 0.8 and 1 ETH asks removed in different batch orders.
   Both ended unlisted, but permanent history could retain either amount. Under
   this design, if both disappear in one refresh and the previous daily price
   was 0.8 ETH, it stays 0.8 ETH. If only the cheaper ask disappears, the
   published price becomes 1 ETH.
   [Daily-price writer](../../indexer/src/infra/storage/sqlite-daily-listing-prices.ts)
   · [Listing history contract](09-domain-activities.md)
4. Publish in **one SQLite transaction**. Check that the preceding generation,
   relevant feed and binding revisions, chain evidence and price validity
   windows still match the staged calculation, including its UTC day. If
   anything moved, abandon the commit and recompute the affected results before
   retrying. Otherwise switch the active generation, publish its per-order
   changes, apply the prepared daily-price writes, advance affected collection
   revisions and release required follow-up work through the outbox. Mark the
   refresh successful at that commit. A failed daily-price write rolls the whole
   publication back. Staging can span batches and a restart. Neither users nor
   history see an intermediate batch.
   [SQLite write policy](../development/02-sqlite-write-contention.md) ·
   [Transactional outbox](05-storage-and-schema.md#metadata-refresh-follow-ups-and-queue-outbox)
5. Resume or discard unpublished work using its run ID and market definition.
   Retry after commit by recognizing the already published generation. Key
   queued work by feed, placement and observation revision. Recheck the current
   placement at the order writer so a delayed upsert cannot resurrect a removal.
   A missing order drops out in the publication transaction even if the queue is
   backed up. Keep the applied change and removal revision for the existing
   retention and replay window.
   [Dispatch](../../indexer/src/application/offchain/dispatch.ts) ·
   [Order queue recovery](18-order-queue-recovery.md)

## Read one combined book

**Prices.** Rank listings by the total the buyer must pay on an eligible route.
Rank indexed seller-facing offers by what the seller receives after all required
fees. Keep gross amount, required fees and net proceeds in exact currency units.
Compare like currency and fill quantity, with a stable order and route
tie-break. For each verified order, choose the eligible route with the lowest
buyer cost or the highest seller proceeds for the requested quantity before
ranking orders. Keep its price, fees and destination together when selecting or
linking the winner. If fees, eligibility or remaining quantity cannot be
established, retain the observation without advertising an executable price.

A VVV listing displayed as 0.13 ETH requires **0.130585 ETH** across all
recipients. That is the buyer’s cost. One captured VVV bid offers **0.0914095
WETH** and requires **0.000819 WETH** in seller-paid fees. It pays **0.0905905
WETH**. A fee-free **0.091 WETH** bid therefore ranks higher for the seller of
the same NFT. The adapter notes describe the gross bid on the existing
competition scale. For the combined indexed book, the seller-proceeds rule here
supersedes that proposed gross ranking for both venues. The bot continues to
compare gross OpenSea bids. Start VVV with fixed-price, single-unit cash
listings and offers. NFT-for-NFT and NFT-plus-currency trades are deferred.
[Captured signed terms](22-vvv-orderbook-adapter.md#read-the-signed-terms) ·
[Bot bid-price calculation](../../shared/trading/open-sea-bidding-offers.ts)

**Audience.** The collection page groups public offers and a token page includes
those applicable to that NFT. A token bid or an offer directed to a specific
seller cannot set a best bid advertised to every holder. Require proven
membership for trait or criteria offers. A reported VVV counterparty is venue
evidence. Use signed restrictions, route rules and ownership evidence when
claiming who can accept a bid. Retain the public observation for its known
target while eligibility for a particular seller is unresolved.
[Token sets](07-domain-orders.md#token-set-materialization) ·
[Bid-book repository](../../backend/src/infra/trading/sqlite-bidding-bid-book-repository.ts)

**Rows, counts and floor.** The collection view, token cards and listed sorting
use the same price selection. Read rows, order and token counts, and the floor
from one SQLite snapshot at one collection revision and evaluation time.
Deduplicate settlement orders and choose their eligible routes **before**
grouping and paging. Page groups in stable order in SQLite, then fetch route
details for the returned orders. Index both settlement-order lookups and feed
membership. A continuation cursor identifies its view version and sort position.
Restart the page sequence when that version or a time-based eligibility boundary
changes. [Current asks](../../shared/database/current-asks.ts) ·
[Collection reads](../../shared/read-models/collections.ts)

**Refresh and navigation.** Preserve the existing public single-collection scope
and private-context rules. Check the collection revision on each cache hit and
prevent an older refresh from overwriting a newer result. Expire price caches at
the next relevant start, expiry or freshness deadline. Changes to attribution,
audience, validation and ownership can invalidate a result even when the amount
stays the same. Link a displayed price to its eligible route when the
destination is verified, otherwise use local token detail. Users browse all
eligible indexed marketplaces together on the existing pages. Attribution is
available for later hints on a focused token card.
[Collection detail cache](../../backend/src/application/use-cases/collections/cached-get-collection-detail.ts)
·
[Public read scope](../backend/02-http-security-and-deployment-modes.md#public-single-collection-mode)

### Bot snapshot selection

Both bid-book routes select the OpenSea bot snapshot when the collection has an
enabled bidding job, its running heartbeat is fresh and the snapshot is fresh. A
fresh empty snapshot displays zero offers. On fallback the user sees the
combined indexed offers. Listings always read the local projection. Identify the
selected feed and its price basis. Bid placement, repricing and competition
indicators use the bot’s OpenSea competition data. A higher seller-facing offer
on VVV changes the indexed book only. A matching maker can identify an own
offer. An own-order action, pending cancellation or completed cancellation
applies only to the exact placement the job controls. A VVV placement for the
same maker or signed order remains independent.
[Display selection and trading authority](../trading/03-market-data-and-scaling.md#bid-book-display-selection)

## Open product decisions

- **How old may a quote be and still set a current price?** Set the allowed age
  for each feed, including during an outage or sequence gap. Last-seen data and
  its age remain available offline. Once the limit is crossed it leaves current
  rankings even if the order has time left.
- **How should a seller see a public offer whose audience is uncertain?** Decide
  whether the focused token card shows that observed offer separately or shows
  only offers known to apply to that seller. Only offers with proven eligibility
  can set a price advertised as available to that audience.
- **Which currency should a single-price card show when several qualify?** The
  current ask reader accepts both ETH and WETH. Calculate a floor for each
  currency and fill quantity. Choose a display preference for a card with room
  for one amount. It must show the chosen currency and keep the price and route
  together.

## Acceptance before enabling additional feeds

- Bootstrap clean SQLite and empty queues. Test two unrelated collections, two
  local ranges on one contract, one shared market fetched once, a scope change
  or purge during a read, and a VVV-only collection with OpenSea disabled.
- Replay smaller, equal-sized and empty VVV books, unchanged timestamps with
  changed availability, a failed read followed by a valid empty read, removal
  then reappearance, and a delayed upsert. Exercise a bounded window, search
  omissions, overlapping feeds and a sequenced gap through replay or a fresh
  baseline. Check each individual change, its authority and the resulting price.
- Interrupt staging, fail the publication transaction, then restart before and
  after its commit. Read concurrently during a multi-batch replacement. Check
  rows, counts, floor and existing daily history against one version, including
  both orderings of the two-ask removal. Repeat while another venue or the chain
  changes an affected quote.
- Exercise a relayed order, two independent placements, two otherwise identical
  orders with different salts, and identical hashes on different deployments.
  Check total quantity after a partial fill, cancellation and reorg. Verify both
  fee examples, audience restrictions, route links, and the bot’s fresh, empty
  and fallback views with an own cancellation on one placement.
- On a deep book, add many duplicate publications and check that pages have the
  same groups, counts and floor with no repeated or skipped group. Inspect query
  plans and measure peak memory to verify a page read does not materialize the
  whole book. Verify a packaged ArtGod worker can read VVV repeatedly, restart,
  recover after an outage and report the age of the last successful read
  throughout. The saved responses and existing OpenSea tests cover the
  comparison and price inputs. These multi-feed and packaged-worker cases
  require implementation evidence.
  [Discovery and verification notes](23-orderbook-discovery.md#checks-completed-on-25-november)
