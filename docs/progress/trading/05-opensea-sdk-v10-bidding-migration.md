# OpenSea SDK v10 Bidding Migration

Status: Implemented for trading runtime

This note captures the compatibility decision for moving the bidding bot from the old `opensea-js` package/API shape to `@opensea/sdk` v10 and aligning `@opensea/stream-js` with the current OpenSea stream package.

## Compatibility Assessment

The new SDK is not a drop-in replacement for the bidding bot.

Material differences:

- package name changed from `opensea-js` to `@opensea/sdk`
- SDK v10 exposes a viem entrypoint at `@opensea/sdk/viem`
- `OrderSide.OFFER` changed from the old string value `bid` to `offer`
- `OpenSeaAPI.getOrders(...)` was removed
- exact-token offers now use `OpenSeaAPI.getOffersByNFT(collectionSlug, tokenId, limit, next)`
- `createOffer(...)` and `createCollectionOffer(...)` return v2 `Offer` / `CollectionOffer` payloads instead of the old `OrderV2` shape

Equivalent-enough surfaces:

- `getAllOffers(...)`, `getCollectionOffers(...)`, `getTraitOffers(...)`, `getTraits(...)`, `getBestOffer(...)`, and `getOrderByHash(...)` still exist
- `sdk.createOffer(...)`, `sdk.createCollectionOffer(...)`, and `sdk.offchainCancelOrder(...)` still exist
- collection and trait offer criteria payloads still include `criteria`, `protocol_data`, and Seaport parameters required by the shared bidding parser
- `@opensea/stream-js@0.3.1` keeps the subscription methods used by the bot and moves the default websocket endpoint to `wss://stream-api.opensea.io/socket`
- Stream JS `0.3.x` adds `event.version`; the bot keeps treating stream events as wake-up hints and does not depend on the version field for placement decisions

## Decision

Keep the direct OpenSea model and update only the adapter/runtime boundary.

The bot still owns bidding decisions through direct OpenSea snapshot/API/SDK lanes. ArtGod indexed `orders` remain display fallback data, not a bidder decision source.

Implementation decisions:

- use `@opensea/sdk/viem` in the trading runtime
- remove direct trading-runtime imports from `ethers`
- replace removed token-offer `getOrders(...)` calls with paginated `getOffersByNFT(...)`
- filter maker-specific token offers client-side because the replacement endpoint is slug/token scoped
- keep OpenSea concrete types out of the bidding core by preserving local `OpenSeaApiClient` and `OpenSeaBiddingSdkClient` interfaces
- normalize SDK v10 offer responses from `order_hash`, `protocol_address`, and nested protocol `endTime`
- keep snapshot, bidding, and stream key lanes separate
- pin `@opensea/stream-js` to `0.3.1` in the trading workspace

## Remaining Risk

Live API and stream verification is still required with real OpenSea credentials before merge because the local tests cover adapter shape and parser compatibility, not production rate limits, stream delivery, or endpoint ordering guarantees.
