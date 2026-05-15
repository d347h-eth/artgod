# OpenSea SDK v10 Indexer Migration

This note captures the compatibility decision for moving the indexer OpenSea REST polling adapter from the old `opensea-js` GitHub dependency to `@opensea/sdk` v10 and aligning the OpenSea stream package with the current published version.

## Current Indexer Surface

The indexer does not use the signing SDK. It uses the REST API client inside `indexer/src/infra/offchain/opensea-api.ts`.

The concrete adapter keeps the same core port exposed to `OpenSeaOrderbookSync`:

- `resolveCollectionByContract(contractAddress)`
- `forEachListing(collectionSlug, contractAddress, handler)`
- `forEachOffer(collectionSlug, contractAddress, handler)`

## Compatibility Decision

The REST calls used by the indexer are still present in `@opensea/sdk@10.5.0`:

- `api.getContract(contractAddress, Chain.Mainnet)`
- `api.getAllListings(collectionSlug, limit, next, includePrivateListings)`
- `api.getAllOffers(collectionSlug, limit, next)`

The removed v10 endpoints are not part of the indexer reconciliation/bootstrap adapter contract. In particular, the indexer does not call the removed `getOrders` endpoint.

The migration therefore remains a dependency/import update, while preserving the existing snapshot/reconcile behavior and payload normalization.

The stream worker uses `@opensea/stream-js` only through `OpenSeaStreamAdapter`.
`@opensea/stream-js@0.3.1` keeps `OpenSeaStreamClient`, `Network.MAINNET`, `LogLevel.ERROR`, `EventType`, `onEvents(...)`, and `disconnect()`.
The package now defaults to `wss://stream-api.opensea.io/socket` and stream messages include a `version` field, but the indexer still persists raw events and normalizes from existing payload fields.

## Remaining Verification

The automated tests cover adapter normalization and the TypeScript surface. A live OpenSea API and stream run with real credentials is still needed to confirm production pagination, rate-limit behavior, and stream delivery after the package upgrade.
