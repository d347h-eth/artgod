# Off-Chain Data & Integration

## 1. OpenSea / Seaport Ingestion

Handling off-chain orderbooks requires a different pipeline than on-chain events.

### Ingestion Pipeline

1.  **Source:** WebSocket (OpenSea Stream API).
2.  **Listener:** `WebSocketService` subscribes to `item_listed`, `item_received_bid`.
3.  **Queue:** Pushes raw payloads to `opensea-listings-queue`.

### Processing Logic (`SeaportOrderProcessor`)

1.  **Parse:** Extract `protocol_data` (parameters, signature).
2.  **Validate:**
    - Check signature validity.
    - Check order expiry.
    - **Conduit Check:** Verify if the maker has approved the OpenSea Conduit.
        - _Optimization:_ Cache "Open Channels" in DB (`seaport_conduit_open_channels`).
        - _Fallback:_ If channel unknown, query `ConduitController` contract on-chain.
3.  **Persist:** Insert into `orders` table with status `active`.
4.  **Reaction:** Trigger `order-updates-by-id` to double-check balance/approval immediately (or trust the stream initially).

## 2. Metadata Pipeline

Metadata is often off-chain (IPFS, HTTP).

### Flow

1.  **Trigger:**
    - New Mint detected (`sync-pipeline`).
    - `MetadataUpdate` event detected (ERC4906).
    - Manual Refresh request.
2.  **Job:** `fetch-metadata-queue`.
3.  **Fetcher Adapter:**
    - Resolves `tokenURI` (on-chain call if needed).
    - Handles IPFS gateways, Arweave, HTTP.
    - Decodes Base64 data URIs.
4.  **Parser:**
    - Normalizes attributes (Trait Type / Value).
    - Extracts media (Image, Animation URL).
5.  **Persistence:** Updates `tokens` and `token_attributes` tables.
6.  **Collection Level:** If new traits are found, trigger `recalc-collection-attributes` to update floor prices per trait.

## 3. Focus Mode (Single Collection)

For tailored use cases (e.g., a brand marketplace), the system supports **Focus Mode**.

### Logic

- **Filter Gate:** In `SyncPipeline`, after `ParseEvents`, strictly filter `EnhancedEvents`.
    - _Rule:_ Keep event IF `address == FOCUS_CONTRACT` OR `txHash` contains a relevant event.
- **Ownership Fallback:** If `nft_balances` is incomplete (due to partial backfill), use an on-chain fallback:
    - When validating an order, if DB says "no balance", call `ERC721.ownerOf(tokenId)` on-chain.
    - If on-chain confirms ownership, allow the order (and valid-cache the result).
