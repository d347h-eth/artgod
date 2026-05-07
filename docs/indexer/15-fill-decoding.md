# Fill Decoding

This document captures the current onchain fill-decoding rules for ArtGod. It exists because sale extraction has several edge cases where marketplace UI feeds, trace-based indexers, and protocol logs can disagree about what should be shown.

The indexer should treat chain/protocol facts as the source of truth at the raw `fills` layer. Product-facing summaries can collapse or relabel those facts later, but the decoder should avoid mutating one protocol event with values from another protocol event.

Primary files:

- `indexer/src/application/fills/seaport.ts`
- `indexer/src/application/fills/seaport-shared.ts`
- `indexer/src/application/fills/blur.ts`
- `indexer/src/application/fills/types.ts`
- `indexer/tests/decode-fill-fixtures.test.ts`
- `indexer/tests/fixtures/fill-txs/`

## Core Principles

Fill decoding follows these principles:

- No transaction traces are required.
- NFT transfers from tracked collections are the entrypoint for transaction selection.
- Full transactions and receipts are fetched only for transactions that contain tracked NFT transfer events.
- Seaport fills are decoded from receipt `OrderFulfilled` logs.
- Blur fills are decoded from Blur calldata for supported methods.
- A persisted fill must be internally consistent:
    - one order id
    - one side
    - one maker/taker interpretation
    - one price/currency
    - one log index or protocol call source
- Do not graft price/currency from one `OrderFulfilled` log onto another order's identity.
- If a bundle contains multiple standalone protocol fills, persist multiple fill rows.
- If a matched-order execution emits buy/sell mirror logs for one NFT transfer, keep one canonical fill for that transfer.
- Currency in `fills.currency` is the execution/protocol currency, not a normalized display currency.

## Data Flow

The sync worker flow is:

1. Fetch tracked NFT `Transfer` logs for enabled collections.
2. Group the decoded NFT transfer events by transaction.
3. Fetch the transaction and receipt for each relevant transaction.
4. Decode fills using the transaction calldata and receipt logs.
5. Match decoded fill candidates to concrete tracked NFT transfer hops.
6. Persist `fills` rows idempotently.
7. Project activity rows from persisted `fills`.

This keeps bandwidth constrained to transactions that already touched a tracked collection while still exposing enough receipt context to decode routed marketplace activity.

## Seaport Decoding

Seaport decoding is receipt-log based. The decoder scans receipt logs for known Seaport exchange addresses and `OrderFulfilled`.

Known Seaport addresses are defined in `SEAPORT_EXCHANGE_ADDRESSES` in `indexer/src/application/fills/seaport.ts`.

For each `OrderFulfilled` log:

- If tracked NFTs appear in `offer`, the order side is `sell`.
- If tracked NFTs appear in `consideration`, the order side is `buy`.
- If tracked NFTs appear on both sides, the log is skipped.
- If no tracked NFTs appear, the log is skipped.
- If the opposite side has no native/ERC20 currency item, the log is skipped.
- If multiple currencies are present in the same fill, the log is skipped and warned.
- Multi-token orders emit one fill per tracked NFT item.

The side names mean orderbook side:

- `sell`: the maker offered the NFT and receives currency.
- `buy`: the maker offered currency and receives the NFT.

This is different from "user clicked buy" or "user clicked sell" in a marketplace UI. Routed protocols can make those user-facing intents much less direct than the underlying Seaport side.

## Transfer Matching

Receipt logs alone are not enough because Seaport can emit mirror buy/sell logs around one NFT transfer, and routed transactions can contain unrelated NFT movement.

The decoder therefore groups Seaport fill candidates by `contract + tokenId` and matches candidates to concrete NFT transfer logs from the tracked collection.

Candidate-to-transfer scoring:

- A `sell` fill matches strongly when `transfer.from == fill.maker`.
- A `buy` fill matches strongly when `transfer.to == fill.maker`.
- A `buy` fill can also match when `transfer.from == fill.maker`; this handles sell-side wrapper/custodian patterns.
- `tx.from` direction is used as a tie-breaker when it identifies the effective taker side.

After candidates are assigned to transfer hops:

- Different transfer hops can each produce a fill row.
- Multiple candidates assigned to the same transfer hop are canonicalized.

This is why Gondi-style multi-hop transactions persist multiple fills, while matched buy/sell mirror logs for one transfer persist only one fill.

## Matched-Order Canonicalization

Seaport matched executions can emit paired `OrderFulfilled` logs for one NFT transfer. Persisting both as sales would double-count one orderbook fill.

For one NFT transfer with both `buy` and `sell` candidates:

1. If `tx.from == transfer.from`, keep the `buy` candidate.
2. If `tx.from == transfer.to`, keep the `sell` candidate.
3. If `tx.from` does not disambiguate:
    - if there is exactly one `buy` and one `sell`
    - and they use the same currency
    - and `buy.price > sell.price`
    - keep the `buy` candidate as the gross bid fill.
4. If still ambiguous, skip and warn rather than double-count.

The gross-bid tie-breaker exists for delegated custodian bid settlements where the transaction caller is not the NFT transfer sender or recipient.

## Regular Seaport Cases

### Direct Take Ask

Shape:

- NFT appears in Seaport `offer`.
- Native ETH or ERC20 appears in `consideration`.
- Transfer usually moves from seller to buyer.

Persisted fill:

- `kind = seaport`
- `order_side = sell`
- `price = sum(currency consideration)`
- `currency = native ETH zero address or ERC20 token`

Fixture examples:

- `0x30e4c9eabe1a74cb71ea2d9f4405318d277f0d0e5590f31d450704c5c98803cd`
- `0xe24f0e18fce6c1195bd8d0f51ca41c547f6570e4dd990263789a19e9b11d64cb`

### Direct Take Bid

Shape:

- Currency appears in Seaport `offer`.
- NFT appears in `consideration`.
- Transfer usually moves from seller/taker to bid maker.

Persisted fill:

- `kind = seaport`
- `order_side = buy`
- `price = sum(currency offer)`
- `currency = native ETH zero address or ERC20 token`

Fixture examples:

- `0xff81723998672fc56590b551ce13ac409cb3f365219e2aef20fcf194652b7d00`
- `0xe6fcee3b20d041194bdbf9b4a53ab9ad4651241b293c3bd14c5ed6255d3a0d01`
- `0x10639cf281b96d54a1bb4fe9b34647e77cac1e05468642e08978cbf6f06d198d`

## Routed Seaport Fills

Routed fills do not require router-specific sale decoders when the route ultimately settles through Seaport. The Seaport `OrderFulfilled` logs are enough as long as they correlate to tracked NFT transfers.

Supported baseline rule:

- log address is known Seaport
- `OrderFulfilled` contains a tracked NFT
- opposite side contains native/ERC20 currency
- candidate maps to a tracked NFT transfer in the same transaction

Current examples:

- RelayRouterV3 routed take-ask:
    - `0x403a5089cb5ca2245949f7ca251bd067fbf2d7092215d295acba53e262e015d7`
- RelayApprovalProxyV3 routed take-ask:
    - `0x4b7a8b0ba714aa9e74ee181befd6e112a8d325c1758f2fb56e3eb083afda5c18`
- RelayApprovalProxyV3 routed batch:
    - `0xdfa4558783c3ada80050ec06ff0b872eded71d39c58bde4b4b1b64525e02fef1`

Relay may pre-fund through WETH while the Seaport item is native ETH. For raw Seaport fills, the Seaport item currency is canonical. Router funding paths can be modeled later as payment-route context.

## Bot Flip Transactions

MEV/arbitrage transactions can buy an underpriced listing and immediately sell the NFT into a higher bid.

When there are two real NFT transfer hops:

1. seller -> bot
2. bot -> bid maker

persist two fills:

- listing/take-ask fill (`sell`)
- bid/take-bid fill (`buy`)

Fixture examples:

- `0x56a35192a95b9a30a699cf01ff0fbd30a0433484545870179228b45c0c5f34d3`
- `0x0e1ea484c1ea7b02c82d64b7a8bdc46d15de6442524e4a54970a72bff9a49678`
- `0xe710043105976c45a157cd6b2005e827491fe311b2aaf8b40460ed5f30f91638`

Some bot flips also emit an extra same-transfer mirror order. That mirror is not persisted when it maps to the same transfer hop as the canonical bid fill.

## Delegated Custodian Bid Settlement

Some MEV flows split the flip across multiple transactions in one block:

1. actor buys an underpriced listing
2. actor transfers the NFT to an intermediate custodian/bot
3. actor invokes the custodian to settle into an existing bid

In the final bid-settlement transaction, `tx.from` may be neither the NFT transfer sender nor recipient.

Example:

- `0x11c0f7a4c2c2d27156b7faa9c243d32a94cae0c90f099f97d9780579be60192e`

Observed shape:

- NFT transfer:
    - custodian `0x54d28...` -> bid maker `0x35B6...`
- buy-side `OrderFulfilled`:
    - maker is bid maker
    - price is gross bid `0.37 WETH`
- sell-side `OrderFulfilled`:
    - maker is custodian
    - price is seller proceeds `0.3663 WETH`

Policy:

- keep the `buy` fill because it is the gross bid order and represents the market sale price.
- do not persist the same-transfer seller-proceeds mirror row.

This is the reason for the gross-bid tie-breaker described above.

## Gondi Purchase Bundles

Gondi buy-with-loan transactions can contain two real Seaport fills:

1. Gondi purchase bundler takes the existing ask/listing.
2. Gondi purchase bundler sells the received NFT to the tx originator/borrower through a private Seaport order with a markup.
3. The borrower then transfers the NFT into loan escrow.

Only the first two are fills. The escrow transfer is not a sale fill unless it has its own protocol order fill.

Policy:

- persist both Seaport fills when they map to separate NFT transfer hops.
- do not merge the private order's gross price onto the original listing order.
- keep `order_id`, side, maker/taker, price, currency, and log index from each exact `OrderFulfilled` log.

Fixture examples:

- `0x63bc418aba6101800257ed659efc4b82b825b6bd25d98d799c7fc5f7aed3308c`
- `0xbaf62d4821e341ec0d59ba39ad2fd83136c03c6cfba4937c43ccad0c62c1216c`

Gondi sell wrapper example:

- `0xf197ae589a91e2e563c1fa3a30545ae383b9c95e281abce1b9aae59be18246ec`

In that case the marketplace bid fill is still the relevant persisted sale fill.

## Multi-Token Orders

A single Seaport order can transfer multiple tracked NFTs.

Policy:

- emit one fill row per tracked NFT item.
- keep the same order id/log index for rows that came from the same `OrderFulfilled` log.
- keep the same gross order price on each per-token row until a later allocation model exists.

Fixture example:

- `0xf2581f8779cb451f662ea3bbc5f6051121c68e3ed653270505cee26315a4e478`

This transaction is protocol-valid even if it is a phishing/scam sale. The decoder should persist protocol truth; later product layers can flag suspicious context.

## Blur Decoding

Blur V2 fills are decoded from calldata for known methods. Current supported methods:

- `takeAskSingle`
- `takeBidSingle`
- `takeBid`
- `takeAsk`
- `takeAskSinglePool`

Current examples:

- take ask single:
    - `0xb2d2fc84955e498ea5079d95a4cba4726e3771369cb7bfa784de0b01e8e06050`
- take bid single:
    - `0x2e99eb8492a1a6732bab9a8feaa58635c04710da0065ccca8b47efb2d90feebb`
- take bid batch:
    - `0x9ed1dee993634827655217ad5d0b36047acb4ce67748a70efb5e3d02cf4f43cd`
- take ask batch:
    - `0x406e361a6cc71c62326f0fddb92bfc291459da516b4dc928a789a8b8c7a80416`
- take ask from Blur pool/BETH:
    - `0x0a1a86e26d16771806e1266e5b77eca7de1e4c73989ffa66452b5c60f9bf1994`

## Blur BETH / Pool Currency

Blur pool fills can settle through the Blur pool token:

- `0x0000000000a39bb272e79075ade125fd351887ac`

Policy:

- persist this address as `fills.currency`.
- do not flatten it to ETH at the raw fill layer.

Other feeds may label these rows as ETH because they display economic equivalence or user-facing payment framing. ArtGod's raw `fills` table stores execution/protocol currency. Display normalization can be added above the raw fact layer.

## Marketplace Feeds Are Not Ground Truth

OpenSea, Blur, and trace-based indexers can expose the same transaction differently:

- UI feeds often collapse routed flows into one human-facing sale.
- Trace-based feeds may choose one side of a matched execution.
- Marketplace UIs may attribute buyers/sellers to final recipients rather than protocol makers.
- Some feeds display net proceeds while others display gross bid/listing price.
- Some feeds normalize Blur pool/BETH to ETH.

ArtGod should use these feeds as comparison tools, not as ground truth. The decoder's ground truth is:

- Seaport/Blur protocol payloads
- tracked NFT transfer logs
- transaction and receipt data available from standard JSON-RPC

## Raw Fills vs Product Views

The `fills` table is a protocol-fact table with light canonicalization to avoid same-transfer double-counting.

Product-facing views can later derive:

- user-facing sale summaries
- financing/bundler context
- suspicious/phishing labels
- router attribution
- gross/net fee breakdowns
- collapsed multi-step bundle summaries
- normalized display currency

Those derived views should not mutate raw fill decoding rules.

## Test Coverage Expectations

Every new fill-decoding edge case should add a fixture under:

- `indexer/tests/fixtures/fill-txs/`

And an assertion in:

- `indexer/tests/decode-fill-fixtures.test.ts`

Fixture tests should cover:

- side
- token id
- price
- currency
- number of emitted fills

Use `scripts/dump-tx.js` to capture transaction + receipt + block data for new fixtures.

## Current Known Limits

- No transaction traces are used.
- Criteria-based Seaport NFT items are skipped until criteria resolution is implemented.
- Mixed-currency Seaport fills are skipped.
- Multi-token orders currently duplicate gross order price per token row; allocation is deferred.
- Router payment-path details are not persisted as first-class context yet.
- Financing context such as loan emission/repayment is not modeled in `fills` yet.
- Blur methods not listed above are not decoded yet.
