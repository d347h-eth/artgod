# VVV orderbook adapter

**VVV adapter.** VVV supplies market locations and signed order data to the
same local indexer that reads OpenSea. The adapter’s job ends after it
identifies a market, reads its public book, and translates its records. The
order domain decides what changed and what price users see.
[Shared orderbook design](21-multiple-orderbooks.md) ·
[Discovery notes](23-orderbook-discovery.md)

## Find and read a VVV market

The reference worktree contains a saved anonymous read of
`GET /api/111k/state?orders=1` on `www.vvv.so`. The response identifies Ethereum
chain ID 1 and NFT contract `0x08cded8258730bda384ff198001e47a1b50f7f9d`. Store
those values and that locator as one entry in the VVV adapter’s market catalog.
Verify the response against the entry on each read. The `111k` path identifies
this market on VVV. Another verified locator can be added to the same adapter.
ArtGod collection names, extensions and OpenSea slugs play no part in finding or
running it.

Use the public `orders` array as the read boundary. The same response carries
`myOrders`, fills, activity and 42,759 inventory items in the 24 November
capture. Reading those into the orderbook would mix different data and, for
`myOrders`, a different audience. Decode orders in bounded batches and keep only
the terms needed by the order pipeline. Validate the response identity, JSON
structure and end of the read before accepting a new book. A response over the
reader’s configured limit fails the read. A partial array cannot replace the
previous book.

### Fetch the book from a browser in a local worker

Use the shared orderbook reconciler’s browser session for the initial read of
a bound VVV market and each scheduled refresh. The standalone probe used
Playwright to open a VVV page in headless Chromium and fetch the public book
from inside that page. On 16 November the
in-page request received the book as JSON with HTTP 200. Playwright’s direct
HTTP client and curl both received HTTP 429 for the same URL. A second browser
read succeeded on 24 November.
[Capture records](23-orderbook-discovery.md#checks-completed-on-25-november)

The shared reconciler starts the browser on the first eligible VVV job. An idle
installation and an OpenSea-only installation both leave the browser closed.
The adapter reopens the session on a later read if the browser exits, and
releases it when the last VVV market is removed or the reconciler shuts down.
The scheduler and order domain use the same paths for both venues. Users can
open a collection page later and read the book ArtGod has already indexed.
[Shared worker lifecycle](21-multiple-orderbooks.md#run-two-shared-orderbook-workers)

The packaged indexer includes the Playwright driver. The account running a
VVV-enabled reconciler needs the matching Chromium installation in Playwright’s
browser cache or at its configured `PLAYWRIGHT_BROWSERS_PATH`. For the verified
111K market, Chromium opens the public `/api/111k/artists` JSON document and
fetches `/api/111k/state?orders=1` from that page without credentials. Both
locations belong to the adapter’s catalog. The page is reused across refreshes.

The indexer pulls at most 64 KiB per chunk and stages each completed public
order before asking for more bytes. A book read has a 45-second deadline and a
32 MiB decoded response limit. Invalid JSON, a mismatched market, an interrupted
response or HTTP 429 leaves the prior book and successful timestamp intact.
The scheduler checks the VVV market’s own 15-minute refresh interval even when
OpenSea uses a longer interval.

On 25 November 2026 the packaged Linux scheduler and reconciler published the
live public book. Local browser fixtures exercised interruption, recovery,
multiple bindings and releasing Chromium after the last binding was removed.
The packaged worker also replayed both full archived responses.
[Packaged worker test](11-testing.md#packaged-orderbook-workers)

## Read the signed terms

The public response for 24 November contains 3,196 distinct orders. The counts
below come from the Seaport offer and consideration arrays. Every row had VVV
status `active`. VVV’s separate `fillable` flag varied.
[Capture identity and checks](23-orderbook-discovery.md#checks-completed-on-25-november)

| What the maker offers and requests           |  Rows | VVV reported fillable | How ArtGod handles it                                               |
| -------------------------------------------- | ----: | --------------------: | ------------------------------------------------------------------- |
| One ERC-721 for native ETH                   | 2,953 |                 2,344 | A currency-priced listing. Compare the total the buyer pays.        |
| WETH for one ERC-721, with WETH fees         |   122 |                    20 | Rank the offer by the WETH the seller receives after required fees. |
| NFTs for an NFT, with currency fees          |   116 |                    60 | Deferred barter. Skip it.                                           |
| NFTs and WETH for an NFT, with currency fees |     5 |                     2 | Deferred barter. Skip it.                                           |

Classify the exchange before admission. A cash offer with a fee stays a cash
offer. Giving an NFT in exchange for another NFT makes it barter even if one
side also pays WETH. The 121 barter offers create no order, validation work,
price or offer count in this design.

- **Order identity.** The adapter reads `order.parameters` and the full
  signature, including bulk proofs. The parameters supply the original offer,
  consideration, counter and validity window. The response omits
  `protocol_address` and `totalOriginalConsiderationItems`. Use the signing
  domain established for the market. Reuse ArtGod’s Seaport component decoder,
  hash and signer checks for both venues. Refactor the existing OpenSea envelope
  reader so only envelope extraction is venue-specific. The component hash uses
  the signed consideration array directly. If an existing DTO needs its original
  length, derive it only from the full array that reproduced the published hash.
  Convert source timestamps in milliseconds separately from the signed times in
  seconds. Parse asset IDs and amounts as exact integers.
  [Seaport envelope reader](../../indexer/src/application/offchain/seaport-order-data.ts)
  ·
  [Seaport identity](../../indexer/src/application/offchain/seaport-protocol.ts)
- **Price.** The first listing’s summary is 0.13 ETH. Its signed amounts pay the
  maker 0.129415 ETH and other recipients 0.00117 ETH, so the buyer pays
  **0.130585 ETH**. The first cash offer has `priceWei = 0` and `giveWeth`
  equivalent to 0.091 WETH. The signed maker amount is **0.0914095 WETH** and
  the required fees are 0.000819 WETH. ArtGod checks whether the bidder can fund
  the full **0.0914095 WETH**. The combined book ranks and displays this bid at
  **0.0905905 WETH**, the amount the seller receives. A competing fee-free bid
  of **0.091 WETH** pays the seller more and ranks above it.
  Reuse `extractSeaportSellTerms` for fixed asks. Move the signed WETH amount
  calculation out of the OpenSea envelope reader so both adapters can reuse
  it. For cash offers, also read the required fee transfers so the order domain
  can compute the seller’s proceeds for each eligible route.
  [Listing terms](../../indexer/src/application/offchain/seaport-order-data.ts)
  · [Offer ranking](21-multiple-orderbooks.md#which-offer-appears-first)
- **Who the offer is for.** The public book includes a `counterparty` on all 243
  offers. Each uses an open Seaport order type and a zero zone. Keep the
  intended counterparty reported by VVV with the publication and the signed
  target token with the order. Of the 20 cash offers VVV marked fillable, six
  named someone other than the target NFT’s owner in that same response. The
  public token book shows an otherwise eligible offer against its signed target.
  Treating VVV’s address as a signed taker restriction would hide offers based
  on an assumption. A claim that a particular person can accept an offer
  requires evidence about ownership and the actual restrictions.
  [Token targets and combined offers](21-multiple-orderbooks.md#read-one-combined-book)
- **Availability.** Apply VVV’s `fillable` flag to its publication. The same
  signed order can still be published by OpenSea. For supported orders use the
  existing order validator for signature, counter, status, balances, ownership
  and approval. Every captured order used a zero conduit key. The existing
  Seaport validator resolves direct approval to the verifying contract in that
  case.
  [Seaport validator](../../indexer/src/application/offchain/seaport-validate.ts)

Using the saved client’s Seaport 1.6 verifying contract
`0x0000000000000068f116a894984e2db1123eb395` on chain 1, ArtGod reproduced every
published order hash and recovered its maker in the later capture. This is an
offline identity check. Fillability depends on chain state at validation time.
[Verification results](23-orderbook-discovery.md#checks-completed-on-25-november)

## Reconcile the public book

Pass each successful read to the shared source-state comparison. If an ID was
present in the previous public VVV book and is missing now, record a removal
immediately and withdraw the VVV quote. The VVV response can shrink, grow, or
return an empty `orders` array. OpenSea can continue to supply the same order.
If the VVV ID reappears, record an addition and use the normal eligibility
checks. If the ID stays present while `fillable` changes, record an update.

The earlier saved response had exactly 5,000 listings. Neither saved response
gave a total for all VVV orders or a next-page cursor. The captures cannot tell
us whether VVV also hosts orders it never returns in this public book. It has no
bearing on removing a previously published ID. Comparing the two saved books
yielded 4,610 currency-priced orders removed, 2,638 added and 44 still-present
listings whose availability changed.
[Measured differences](23-orderbook-discovery.md#two-saved-vvv-books) ·
[Shared reconciliation rules](21-multiple-orderbooks.md#apply-each-book-change)

## Adapter acceptance

1. Feed a saved listing and WETH offer through the actual venue reader, Seaport
   decoder, order worker and local market queries. Check the buyer’s total
   listing cost, the bidder’s full funding requirement and the seller’s proceeds
   against the signed amounts above. Check the order identity, audience and local
   collection. Include a bulk signature, a tampered order and both barter shapes.
   Check that only eligible cash orders contribute to a price.
2. Read two known VVV books in sequence, including an empty book, then replay
   the last run. Insert a challenge or malformed response between two successful
   reads. Assert the per-order changes and the price visible on the next local
   read. Repeat with an OpenSea publication for the same order.
3. Use a second verified or fixture market on another contract, with an existing
   binding and OpenSea disabled. Check that an unrelated collection keeps its
   own book and that two local collections bound to one remote market cause one
   fetch.
4. Start the packaged shared reconciler with a bound VVV market and no
   collection page open. Verify that its browser reads the initial book and
   subsequent scheduled refreshes. Restart
   the worker and verify it can open a fresh session. Interrupt a browser read,
   confirm the previous book and last successful read time are still visible,
   then let the next read succeed and check the resulting order changes. Record
   the request rate and the peak memory used by the worker and its browser for
   a response the size of the saved book.
