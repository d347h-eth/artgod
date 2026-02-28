# Marketplace Fills: Seaport/OpenSea + Blur

This doc compiles the on-chain fill decoding logic and reference outputs that already exist in this codebase. It is meant to be a compact blueprint for building a smaller indexer.

## Output shape (expected decoded fields)

The indexer’s fill event schema is defined in:

- `packages/indexer/src/sync/events/storage/fill-events/index.ts`

Key fields you should emit per fill:

- `orderKind`, `orderId`, `orderSide` ("sell" | "buy")
- `maker`, `taker` (counterparties)
- `contract`, `tokenId`, `amount`
- `currency`, `currencyPrice`, `price` (native), `usdPrice`
- `orderSourceId`, `fillSourceId`, `aggregatorSourceId`
- `baseEventParams` (block, txHash, logIndex, batchIndex, timestamp)

**Buyer / seller mapping** (derived in APIs; see `packages/indexer/src/api/endpoints/transfers/get-sales/v3.ts`):

- `orderSide = sell (ask)` → seller = `maker`, buyer = `taker`
- `orderSide = buy (bid)` → buyer = `maker`, seller = `taker`

## Seaport / OpenSea fills (OrderFulfilled)

**Event source:**

- Event data is in `packages/indexer/src/sync/events/data/seaport*.ts`.
- Handler is `packages/indexer/src/sync/events/handlers/seaport.ts`.

**Basic sale detection (single-item):**

- Uses `Sdk.SeaportBase.Exchange.deriveBasicSale(...)` in `packages/sdk/src/seaport-base/exchange.ts`.
- Logic summary:
    - If the **offer** is a single NFT (itemType >= 2) and **consideration** is a currency item, it is a **listing fill** (`side = sell`).
    - If the **offer** is a single currency item (ERC20/NATIVE) and **consideration** is an NFT, it is a **bid fill** (`side = buy`).
    - `price` is the sum of consideration amounts (minus any “false consideration” items that exactly mirror the NFT and indicate a recipient override).
    - `currencyPrice = price / amount`.
    - `paymentToken` is the currency item token.

**MatchOrders handling:**

- The handler checks adjacent `OrderFulfilled` logs in the same tx and re-assigns `taker` when the fill is part of a `matchOrders` pair (see `seaport.ts` logic around `orders-matched` and log adjacency).

**Attribution overrides:**

- `extractAttributionData(...)` may override taker or sources.

**Limitations of current handler:**

- Only **basic sales** (single offer + compatible consideration) are decoded into fills. More complex orders will be ignored unless you implement additional decoding.

### Additional Seaport variants supported elsewhere (reference)

`packages/indexer/src/sync/events/handlers/royalties/calldata.ts` can parse orders directly from calldata for:

- `fulfillAvailableAdvancedOrders`
- `fulfillAvailableOrders`
- `matchOrders`
- `matchAdvancedOrders`
- `fulfillAdvancedOrder`
- `fulfillOrder`
- `fulfillBasicOrder(_efficient_6GL6yc)`

This is a good starting point for bulk / multi-item / criteria-based fills that are not handled by `deriveBasicSale`.

### Criteria-based orders (collection / trait offers)

Seaport item types (from `packages/sdk/src/seaport-base/types.ts`):

- `ERC721_WITH_CRITERIA = 4`
- `ERC1155_WITH_CRITERIA = 5`

Example OpenSea trait offer (from `tmp/opensea-multi-trait-offer.json`):

- `itemType = 4` in consideration
- `identifierOrCriteria` is a criteria root, not a concrete tokenId
- `zone = OpenSeaV16SignedZone`
- `conduitKey = OpenseaConduitKey`
- Contains an OpenSea fee recipient in consideration

You will need criteria resolvers or transfer logs at fill time to resolve the actual `tokenId` for criteria orders.

## Blur v1 fills (OrdersMatched)

**Event source:** `packages/indexer/src/sync/events/data/blur.ts`

**Handler:** `packages/indexer/src/sync/events/handlers/blur.ts`

Key behaviors:

- Uses tx trace to find the `execute` / `_execute` call and determine order side:
    - `execute` selector: `0x9a1fc3a7`
    - `_execute` (delegatecall) selector: `0xe04d94ae`
- Determines maker/taker by inspecting the decoded `sell` / `buy` orders.
- Handles router calls and Blend (buy-to-borrow) flows by overriding taker.
- **BETH mapping:** if payment token is BETH, it is normalized to native ETH for pricing **and** persisted as native ETH in the fill record (`currency = AddressZero`).

The OrdersMatched event itself includes a `fees[]` array (recipient + rate), which can be used to compute per-fill fee recipients and amounts.

## Blur v2 fills (Execution\* events + call trace)

**Event source:** `packages/indexer/src/sync/events/data/blur-v2.ts`

**Handler:** `packages/indexer/src/sync/events/handlers/blur-v2.ts`

Key behaviors:

- Requires a transaction trace to locate the marketplace call.
- Supports both **CALL** and **DELEGATECALL** when matching exchange calls.
- Supported method selectors (from the handler):
    - `takeAsk`: `0x3925c3c3`
    - `takeAskSingle`: `0x70bce2d6`
    - `takeAskPool`: `0x133ba9a6`
    - `takeAskSinglePool`: `0x336d8206`
    - `takeBid`: `0x7034d120`
    - `takeBidSingle`: `0xda815cb5`
- Buy-to-borrow detection (affects taker/tokenRecipient):
    - `buyToBorrow`: `0x8593d5fc`
    - `buyToBorrowV2ETH`: `0xbe5898ff`
    - `buyToBorrowV2`: `0xd386b343`

Currency handling:

- `takeAsk*` → currency = native ETH
- `takeBid*` → currency = BETH (normalized to native for pricing)

If no trace is available, fills are skipped (see `blur-v2.ts` logging around `no-trace`).

## Fee classification hints (marketplace vs royalty)

### 1) Known marketplace fee recipients

The canonical list lives in `packages/indexer/src/models/fee-recipients/feeRecipients.json` and is loaded into `FeeRecipients`. Use it to tag fee recipients as "marketplace".

Current entries (domain + address):

- opensea.io: `0x5b3256965e7c3cf26e11fcaf296dfc8807c01073`
- opensea.io: `0x8de9c5a032463c561423387a9648c5c7bcc5bc90`
- opensea.io: `0x0000a26b00c1f0df003000390027140000faa719`
- alienswap.xyz: `0x0b22c0359b550da6cf3766d8c0d7ffc00e28a136`
- looksrare.org: `0x5924a28caaf1cc016617874a2f0c3710d881f3c1`
- x2y2.io: `0xd823c605807cc5e6bd6fc0d7e4eea50d3e2d66cd`
- foundation.app: `0x67df244584b67e8c51b10ad610aaffa9a402fdb6`
- superrare.com: `0x860a80d33e85e97888f1f0c75c6e5bbd60b48da9`
- sudoswap.xyz: `0x4e2f98c96e2d595a83afa35888c4af58ac343e44`
- sudoswap.xyz: `0xb16c1342e617a5b6e4b631eb114483fdb289c0a4`
- benddao.xyz: `0xf3ab1d58ce6b9e0d42b8958c918649305e1b1d26`
- jungle.co: `0x143ed32cd8c609a13dd73b3803d39e7a7544b1a4`
- godid.io: `0xe89b80d335a643495cfcf004037a381565edc130`
- fabrica.land / v3.fabrica.land: `0xe35450f17229010f416355c3acb5cd1d19bebeb6`, `0xc888f5e3dd4fbeb37f6e1ba6fa68c83ab0cf7b2c`
- magiceden.io: `0xca9337244b5f04cb946391bc8b8a980e988f9a6a`
- mint.fun: `0x277c2a47ac1aeb6f77b778dbed48d3d4feea8937`
- hub.auraexchange.org: `0xa2b8e073ea72e4b1b29c0a4e383138abde571870`
- manifold.xyz: `0xd58f2402d104df9c8a8667e24a3a5c79f8ec66aa`
- mirror.xyz: `0x138c3d30a724de380739aad9ec94e59e613a9008`
- zora.co: `0xd1d1d4e36117ab794ec5d4c78cbd3a8904e691d0`
- snagsolutions.io: `0x70bf5945845546716e628cedc8f83d82179a79e9`
- story.xyz: `0xc626f08cf88972332cfcb48b227409658be67a1c`
- pass.xyz: `0x72f5812741527440db956dc3fb4487cd7b1b760c`, `0xb7b3a132efcff7ba685c441f85f8e7c4b8e598e4`
- ens.vision: `0xa7673ab3b0949a0efcd818c86c71fff7cd645ac7`

### 2) OpenSea marketplace fees

OpenSea fees are injected when building orders for the OpenSea orderbook (see `packages/indexer/src/utils/marketplace-fees/index.ts`):

- **50 bps** → `0x0000a26b00c1f0df003000390027140000faa719`

### 3) Seaport order fee breakdown

When Seaport orders are saved (e.g., `packages/indexer/src/orderbook/orders/seaport-v1.4/index.ts`), a `feeBreakdown` is computed by:

- Converting each `info.fees` item into a bps share of the price.
- Assigning `kind = marketplace` if the recipient is in `FeeRecipients`, else `royalty`.

### 3b) Fee recipient + amount extraction (event-level)

If you want **fee recipients + amounts per fill**, the raw events already carry enough data:

- **Seaport `OrderFulfilled`**: the `consideration[]` array includes the seller payout and any extra fee recipients. For basic sales, the first consideration item is usually the seller/offerer; any additional items are fees. Amounts are explicit on each item.
- **Blur v1 `OrdersMatched`**: the `sell.fees[]` / `buy.fees[]` arrays include `{ rate, recipient }`. Amounts can be computed as `price * rate / 10000` (rate is in bps).
- **Blur v2 `Execution*`**: events include `makerFee`, `takerFee`, and `protocolFee` structures with `{ recipient, rate }`. Amounts can be computed against the execution `price`.

Example (OpenSea trait offer, from `tmp/opensea-multi-trait-offer.json`):
consideration includes an OpenSea fee line:

```json
{
    "itemType": 1,
    "token": "0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2",
    "startAmount": "3100000000000000",
    "endAmount": "3100000000000000",
    "recipient": "0x0000a26b00c1f0df003000390027140000faa719"
}
```

### 4) Royalty/payment heuristics (used in fill post-processing)

`packages/indexer/src/sync/events/handlers/royalties/core.ts` applies these heuristics to classify payments:

- Use **payment traces** to find actual recipients and amounts.
- If recipient is in `FeeRecipients` → marketplace fee.
- Otherwise, treat as royalty if the effective bps <= 15% (BPS_LIMIT with PRECISION_BASE=100000).
- Excludes common non-royalty recipients: WETH, native ETH, BendWETH, maker, taker, and a known suspicious address.
- **BETH is treated as ETH** for payment analysis.

## Expected decoded outputs per tx (repo-backed examples)

### Blur v1 (from `packages/indexer/src/tests/blur/blur.test.ts`)

Each entry below is the expected decoded fill for the listed tx hash:

- `0xae93dcfee4d67a26b684e2ef0e88553b3a0bcc4d43c77be3638e6c8f2a4b2695`
    - orderSide: buy (bid)
    - maker: `0xe9472fdffaa6792df8ff5faab5866c90dc7f6f22`
    - taker: `0x95cd652430c973b80cbaed8afb869bea4812bb4c`
    - contract: `0x9251dec8df720c2adf3b6f46d968107cbbadf4d4`
    - tokenId: `3064`
    - currency: native ETH (`0x0000000000000000000000000000000000000000`)
    - note: payment token in the Blur order is BETH; handler normalizes to native

- `0x344f5ddfc0d4fd239303f6b67aeb18f57b6932edb123859c7a66548eb0ce5364`
    - orderSide: sell (ask)
    - maker: `0xf16688ea2488c0d41a13572a7399e03069d49a1a`
    - taker: `0x28cd0dfc42756f68b3e1f8883e517e64e474078a`
    - contract: `0xd8b7cc75e22031a72d7b8393113ef2536e17bde6`
    - tokenId: `1000101016`
    - currency: `0x0000000000000000000000000000000000000000` (native)

- `0x0abdd7ceddcb1f54c82a89e0d026fbd160c36ebfe155421443097d3c5cdc9bb2`
    - multiple fills in one tx (two asks)
    - tokenIds: `1578`, `3537`
    - contract: `0xcbc67ea382f8a006d46eeeb7255876beb7d7f14d`
    - orderSide: sell (ask)

### Blur v2 (from `tmp/logs/10x-take-bid-wash0.json`)

Tx with multiple `takeBid*` fills:

- `0xe34cc5b4910c84a7fd274fdc336429b9ff1bd9c91d843459fcfa104c5a3a27e6`
    - orderKind: blur-v2
    - orderSide: bid (buy)
    - example fill:
        - maker (buyer): `0xfdc7ee2c43d3e4ae903ecfb68d731d44b813c620`
        - taker (seller): `0x86486d881b8ca7b4186d6aef4b9c8e6c30be73f0`
        - contract: `0x4e1f41613c9084fdb9e34e11fae9412427480e56`
        - tokenId: `4806`
        - currency: `0x0000000000a39bb272e79075ade125fd351887ac` (BETH)

### Seaport v1.6 (from `tmp/sales-check.json`)

- Ask (sell) example:
    - tx: `0xd5a6ccb60d5ae56801dbbfbac58387b59c11133a91f298ba418fa762d424ab95`
    - orderSide: ask
    - seller (maker): `0x47d4f20ae83bcd350105f199f900e6e6104dab6a`
    - buyer (taker): `0x4f0ecedcd73da0315134741d9d3830b08fe32e95`
    - contract: `0x4e1f41613c9084fdb9e34e11fae9412427480e56`
    - tokenId: `8632`
    - currency: native ETH (`0x0000000000000000000000000000000000000000`)

- Bid (buy) example:
    - tx: `0x2b8b444f9e1bbff32ef95e39864aee02fc80d916860726c5618f86935c14238a`
    - orderSide: bid
    - buyer (maker): `0xe20bc6122ec3fbfab73b15540495ce1bfc82a601`
    - seller (taker): `0xfaec8be993529909885d419eee48ee7787c87a15`
    - contract: `0x4e1f41613c9084fdb9e34e11fae9412427480e56`
    - tokenId: `2527`
    - currency: WETH (`0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2`)

## Exchange addresses (mainnet, chainId=1)

These are pulled from `packages/sdk/src/addresses.json` via `resolveAddress(...)`:

Seaport exchanges:

- Seaport v1.1: `0x00000000006c3852cbef3e08e8df289169ede581`
- Seaport v1.4: `0x00000000000001ad428e4906ae43d8f9852d0dd6`
- Seaport v1.5: `0x00000000000000adc04c56bf30ac9d3c0aaf14dc`
- Seaport v1.6: `0x0000000000000068f116a894984e2db1123eb395`

Seaport infrastructure:

- ConduitController: `0x00000000f9490004c11cef243f5400493c00ad63`
- OpenSea Conduit Key: `0x0000007b02230091a7ed01230072f7006a004d60a8d4e71d599b8104250f0000`
- Reservoir Conduit Key: `0xf3d63166f0ca56c3c1a3508fce03ff0cf3fb691e000000000000000000000000`
- OpenSea V1.6 Signed Zone: `0x000056f7000000ece9003ca63978907a00ffd100`
- OpenSea Protected Offers Zone: `0x000000e7ec00e7b300774b00001314b8610022b8`

Blur:

- Blur v1 Exchange: `0x000000000000ad05ccc4f10045630fb830b95127`
- Blur v1 ExecutionDelegate: `0x00000000000111abe46ff893f3b2fdf1f759a8a8`
- BETH: `0x0000000000a39bb272e79075ade125fd351887ac`

Blur v2:

- Blur v2 Exchange: `0xb2ecfe4e4d61f8790bbb9de2d1259b9e2410cea5`
- Blur v2 Delegate: `0x2f18f339620a63e43f0839eeb18d7de1e1be4dfb`
- Env overrides used by the handler:
    - `BLUR_V2_EXCHANGE_ADDRESS`
    - `BLUR_V2_DELEGATE_ADDRESS`

Blend:

- Blend contract (used for buy-to-borrow taker overrides): `0x29469395eaf6f95920e59f858042f0e28d98a20b`

## Source pointers (code)

- Fill schema: `packages/indexer/src/sync/events/storage/fill-events/index.ts`
- Seaport fills handler: `packages/indexer/src/sync/events/handlers/seaport.ts`
- Seaport basic sale derivation: `packages/sdk/src/seaport-base/exchange.ts`
- Seaport calldata parsing helpers: `packages/indexer/src/sync/events/handlers/royalties/calldata.ts`
- Blur v1 handler: `packages/indexer/src/sync/events/handlers/blur.ts`
- Blur v2 handler: `packages/indexer/src/sync/events/handlers/blur-v2.ts`
- Fee recipients list: `packages/indexer/src/models/fee-recipients/feeRecipients.json`
- OpenSea fee injection: `packages/indexer/src/utils/marketplace-fees/index.ts`
- Seaport order fee breakdown: `packages/indexer/src/orderbook/orders/seaport-v1.4/index.ts`
- Criteria example: `tmp/opensea-multi-trait-offer.json`
- Example outputs (Seaport/Blur): `tmp/sales-check.json`, `tmp/logs/10x-take-bid-wash0.json`, `packages/indexer/src/tests/blur/blur.test.ts`
