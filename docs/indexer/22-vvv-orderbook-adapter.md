# VVV as an orderbook venue

**Proposed venue adapter.** Register VVV once. Its adapter owns VVV's market
references, acquisition and wire format. The same core projection serves VVV,
OpenSea and subsequent venues. The observed market exercises fee-inclusive
prices, directed offers and multi-asset exchanges. To add another VVV market,
resolve its locator and verify its asset coverage. [Multiple orderbooks in ArtGod](21-multiple-orderbooks.md)

## What the saved responses establish

The evidence comes from the `feature/vvv-orderbook-access` worktree. Its
tracked tree matched `main` at `938ece5c`. The capture files are local
research artifacts. The 24 November 2026 response is
`tmp/vvv-orderbook-20261124/state-orders.json` in that worktree, SHA-256
`ff890ff37693fb3f020e8377c9a1cd88792874a6841a9ec6bb46a2cb31ad1c65`.
Its companion `results.json` records an anonymous browser read of
`GET /api/111k/state?orders=1` on `www.vvv.so` at 17:49 UTC. The response
identified Ethereum mainnet, NFT contract
`0x08cded8258730bda384ff198001e47a1b50f7f9d` and block 26,486,617.

The 11,455,722-byte decoded response contained 3,196 distinct order hashes.
Every row had VVV status `active`. Counting the signed asset legs gives the
following breakdown. The last column is VVV's own availability flag.

| Published terms                                                           | Orders | VVV reported fillable |
| ------------------------------------------------------------------------- | -----: | --------------------: |
| One ERC-721 offered for native ETH                                        |  2,953 |                 2,344 |
| WETH offered for one ERC-721, with WETH fee consideration                 |    122 |                    20 |
| One or more NFTs offered for one NFT, with native fee consideration       |    116 |                    60 |
| NFTs and WETH offered for one NFT, with native and WETH fee consideration |      5 |                     2 |

All 243 offers carried a `counterparty`. All used the open order type and
zero zone in this capture. Preserve the address as VVV's description of the
intended counterparty. Inferring a protocol-enforced taker restriction or
public availability requires additional evidence.

The saved VVV client identifies the Seaport 1.6 domain at
`0x0000000000000068f116a894984e2db1123eb395`. Using that domain and chain ID
1, ArtGod's existing `computeSeaportOrderHash` reproduced all 3,196 published
hashes, and `recoverSeaportSigner` recovered the declared maker for all 3,196.
The check used each row's original components and full signature, including
bulk proofs. This establishes signed identity for these rows. Executability
also depends on current counter, cancellations, fills, balances and approvals.
[ArtGod Seaport implementation](../../indexer/src/application/offchain/seaport-protocol.ts) · [Seaport order models](https://docs.opensea.io/docs/seaport-models) · [Seaport status interface](https://docs.opensea.io/docs/seaport-interface)

## Resolve and acquire a market

- The initial market entry can pair VVV's opaque reference `111k` with the
  evidenced URL, Ethereum chain ID and NFT contract. The reference is data
  inside the VVV adapter. Compare the response identity with the binding
  before admitting rows, then match individual legs against tracked token
  scopes. The same matcher works for another contract, a local range or an
  explicit token set. A local slug, extension install or OpenSea association
  carries no evidence of VVV coverage.
- Support verified provider catalog entries as VVV exposes them. Until then,
  an adapter-owned catalog or explicit verified market reference is sufficient.
  A configured market produces at most one in-flight crawl per partition
  regardless of the number of local collections it covers. The evidence
  establishes one locator. Interpolating arbitrary ArtGod slugs into that
  path would invent endpoints.
- Prefer a documented, machine-readable venue feed for scheduled refresh.
  Saved captures show successful anonymous browser reads and an earlier HTTP
  429 challenge on direct clients. A browser-backed reader is a separate
  VVV transport candidate if the venue supports that use. Qualify its
  lifecycle, resource use and availability in each shipped runtime before
  declaring automatic refresh supported. Use saved snapshots to exercise
  the exact same decoder offline. A challenged or unavailable fetch records
  a failed refresh with backoff. The API and UI continue to read local data.
- Stream or incrementally decode the public `orders` array with time, byte
  and row limits. The November response also contained 42,759 inventory
  items, recent fills and other page state. Leave those with their owning
  domains. Keep one order or bounded batch in a queue message. Production
  diagnostics need counts, scope and
  failure reasons. Persist normalized terms required for validation under the
  domain's storage policy.
- Start with **partial coverage** for listings and offers. The 15 November
  capture `browser/state-orders-051.json` in `tmp/vvv-orderbook-20261115/`
  contained exactly 5,000 listings and 217 offers. The 24 November capture
  returned fewer and supplied neither a total for the orderbook nor a next
  cursor. Neither response establishes a cap, exhaustive traversal or an
  authoritative deletion boundary. Upsert positively observed rows. An
  omitted row retains its own last-seen time and ages out of current results.
  Promote a partition to absence-based reconciliation only when VVV's
  coverage contract supports it.

## Decode terms once

1. Decode the venue envelope into a publication observation. Normalize
   millisecond creation/update timestamps separately from signed start/end
   seconds, and record local sighting time. Validate addresses, exact uint256
   IDs and amounts losslessly. Check outer maker, side and token summaries
   against the signed legs. Keep venue status, `fillable` and any reason as
   separate fields. VVV reported 770 active rows as unfillable.
2. Split the OpenSea envelope reader from the reusable Seaport components
   decoder. VVV supplies `order.parameters` with a counter and the full
   signed offer/consideration arrays. Its response omits a protocol address
   and `totalOriginalConsiderationItems`. Resolve the expected signing
   domain from the verified market configuration. The signed components
   suffice for hashing. If a protocol DTO needs the original consideration
   count, derive it from an established full signed array whose hash
   matches. Keep fulfillment-only fields out of the identity contract.
   A domain, hash or signature mismatch cannot create a verified quote.
   [Current Seaport envelope reader](../../indexer/src/application/offchain/seaport-order-data.ts)
3. Derive the economic terms from both legs and every recipient. For a
   simple ask, rank the buyer's total required consideration. For a simple
   fixed WETH offer, use the maker's gross WETH per NFT on the existing
   comparable bid scale and expose fees/net proceeds distinctly. Keep the
   currency and quantity basis with the number. Reserve public best-price
   ranking for offers with proven audience eligibility. [OpenSea unit-price semantics](../../shared/trading/open-sea-bidding-offers.ts)
4. For an exchange, render the maker's offered assets, requested assets and
   additional fees on the collection and relevant token pages. Preserve
   everything the other party must supply. The core can display complete
   observed terms while local fillability is unknown. The current validator
   requires a positive scalar price and selects one sell or buy balance path.
   Reuse its identity, status and pinned-RPC machinery. Qualifying compound
   orders requires checks for every required maker asset, amount and
   approval. All captured orders used the zero conduit key. The validator
   already handles direct approval to the verifying Seaport contract for
   that case. Until compound validation is supported, show the exchanges'
   observed status and terms outside cash rankings. [Current validator](../../indexer/src/application/offchain/seaport-validate.ts)

Two rows illustrate why the distinction matters. The first listing reports
`priceWei` equivalent to 0.13 ETH. Its signed consideration sends 0.129415 ETH
to the maker and 0.00117 ETH to other recipients. The comparable buyer cost is
**0.130585 ETH**. The first WETH offer reports `priceWei = 0` and
`giveWeth = 0.091 WETH` in display units. The signed maker leg offers
**0.0914095 WETH** and the order requires 0.000819 WETH in fee consideration,
leaving **0.0905905 WETH** after those fees. Reading either summary field as
the bid-book price would misprice the offer. A cash fee on an NFT-for-NFT
exchange is likewise a fee, never a valuation of the NFTs.

## Qualify the adapter

| Exercise                                                                                                 | Required outcome                                                                                                                                                                                                                  |
| -------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Replay representative listing, WETH offer, NFT swap and mixed rows through the real adapter              | Preserve fees, recipients, roles, counterparty and time units. Direct and bulk signatures resolve to the expected identity. Tampered terms, an unsupported signing domain or an unsafe numeric ID cannot enter verified rankings. |
| Compare a shared signature and two independent orders on the same token across VVV and OpenSea           | The shared order has both venue links and is counted once. Different signatures over different terms keep their own rows. Local best ask uses exact buyer cost. Every offer type can be inspected.                                |
| Run the same captured page twice, then return a clipped page, a 429 and a newer positive sighting        | One idempotent publication per remote identity. Coverage and age remain truthful. Repeated positive sighting refreshes only the observed publication. OpenSea continues independently.                                            |
| Browse an enabled VVV market without an OpenSea key, then open its listings and offers from token detail | The local market is usable. Link to a verified order or token destination when known. The saved client establishes a market page at `/111k/floor`, which can be labeled as a market destination.                                  |
| Exercise the normal bot display transition and a collection without any VVV market                       | OpenSea bot selection, counts and controls follow their existing evidence. Ordinary OpenSea browsing works with a single bound venue.                                                                                             |

The capture qualifies the decoder design and local identity checks. Scheduled
transport, complete enumeration, freshness limits, per-order navigation and
current onchain availability each need their own evidence.
