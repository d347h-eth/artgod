# Bidding Runtime and Jobs

This document is the current-state reference for ArtGod bidding.
Progress/history notes remain in `docs/progress/trading/*`.
User-facing automation capabilities and backend/API coverage are detailed in `docs/trading/02-bidding-automation-capabilities.md`.

## Status

Bidding is the first trading runtime implemented in ArtGod.

Current implementation:

- the real bidding runtime runs from `trading/dist-desktop/bidding-bot-runtime.mjs`
- declared bidding jobs are stored in SQLite
- backend/Userland expose mutation paths for token, trait, and collection bidding jobs
- running bots reconcile DB job commands without restart
- bid-book UI reads either the bot snapshot projection or canonical orders fallback
- Userland bidding automation can draft jobs from token cards, trait filters, collection bids, and bid-book rows
- collection-scoped price tiers can resolve reusable floor/ceiling/delta settings into scalar job specs
- sniping remains staged but not functionally ported

Admin start eligibility depends on OpenSea capability. If `OPENSEA_INTEGRATION_MODE=disabled`, or `auto` has no `OPENSEA_API_KEY`, the Admin UI reports the OpenSea disabled reason and the native command refuses to start the bot. Bidding also stays disabled until `OPENSEA_STREAM_SECRET_KEY`, `OPENSEA_BIDDING_SECRET_KEY`, and `OPENSEA_SNAPSHOT_SECRET_KEY` are configured.

## Hard Invariants

- The bidding runtime keeps direct OpenSea stream, REST, SDK, and snapshot lanes.
- The bot's collection-offer snapshot is the authoritative market view for bidding decisions.
- ArtGod `orders` rows are never used for bidder competitiveness or placement decisions.
- OpenSea stream events are wake-up hints only; missed stream events are expected.
- The snapshot lane polls every 60 seconds and hot-path callers force a blocking refresh when the snapshot is older than the configured stale threshold.
- Snapshot refresh entrypoints are serialized/deduped by the snapshot service.
- Job execution remains per-job serialized.
- Human-readable config, API, UI, and logs use Ether units; low-level EVM calls and persisted amount columns may use wei strings.
- Wallet secrets never enter env, CLI args, SQLite, frontend state, or logs.

## OpenSea SDK / API Surface

The bidding runtime uses `@opensea/sdk` through the SDK's viem entrypoint.
SDK concrete types remain isolated in runtime composition and the OpenSea adapters; the bidding core consumes local ports.

Current REST/SDK calls:

- exact-token offer discovery: `api.getOffersByNFT(collectionSlug, tokenId, limit, next)`
- collection snapshot and recovery: `api.getAllOffers(collectionSlug, limit, next)`
- collection/trait discovery: `api.getCollectionOffers(...)`, `api.getTraitOffers(...)`, `api.getTraits(...)`
- fallback best-offer lookup: `api.getBestOffer(collectionSlug, tokenId)`
- direct order recovery: `api.getOrderByHash(orderHash, protocolAddress)`
- placement: `sdk.createOffer(...)`, `sdk.createCollectionOffer(...)`
- cancellation: `sdk.offchainCancelOrder(...)`

The old `getOrders` API shape is not part of the bidding runtime contract anymore.
Maker-specific token offer recovery filters the paginated NFT-offer response in the adapter.

## OpenSea Stream Surface

The bidding runtime uses `@opensea/stream-js` for wake-up events only.
The current package version is `0.3.1`, whose public subscription methods remain compatible with the bot's adapter.

Current stream calls:

- `onCollectionOffer(collectionSlug, callback)`
- `onItemListed(collectionSlug, callback)`
- `onItemSold(collectionSlug, callback)`
- `onItemTransferred(collectionSlug, callback)`
- `onItemReceivedBid(collectionSlug, callback)`
- `onTraitOffer(collectionSlug, callback)`

Stream events can include a `version` field, but bidding decisions still come from the authoritative REST snapshot lane.

## Runtime Bootstrap

The desktop supervisor starts wallet-bound trading bots only after an explicit operator unlock.
The Rust process owns keystore decryption and sends the unlocked key to the Node bot through the one-shot stdin secret-envelope path.

Startup order:

1. read the one-shot secret payload and construct the in-memory signer
2. load typed trading config
3. load enabled bidding jobs from SQLite
4. wire OpenSea lanes, metadata lookup, WETH balance/allowance, transaction policy, and logging adapters
5. emit `bot_bootstrapping` before long allowance/snapshot/price bootstrap work
6. approve configured WETH allowance when `BIDDING_WETH_ALLOWANCE_ETH > 0`
7. bootstrap authoritative collection-offer snapshots and current prices
8. start job ticks, snapshot polling, stream listeners, command reconciliation, and heartbeat
9. emit `bot_ready` only after bootstrap is complete

`trading_bot_runtime_state` stores non-secret bot heartbeat state.
Backend bid-book reads use it to decide whether the bot snapshot projection can be treated as live.

## Runtime Logging

The bidding bot emits JSON Lines through the shared ArtGod logger. Every
operator-facing runtime log sets stable `component` and `action` fields for
Alloy/Loki labels, and puts job, collection, token, offer, transaction,
snapshot, retry, and error details into dedicated JSON payload fields.

Lifecycle payloads such as `bot_bootstrapping` and `bot_ready` remain the
supervisor control protocol and are separate from diagnostic log entries.

Bot logs must never include wallet private keys, secret-envelope payloads,
OpenSea secret keys, or raw OpenSea request/stream payloads.

## Job Persistence

SQLite is the only supported declared-job source.
The temporary JSON job file source has been removed.

Primary tables:

- `trading_jobs`: common declared job envelope for bidding and future sniping
- `trading_bidding_job_specs`: bidding strategy fields (`floor_wei`, `ceiling_wei`, `delta_wei`, quantity, trait criteria)
- `trading_bidding_job_runtime_state`: bot-owned active-offer/runtime state for cancellation and diagnostics
- `trading_job_commands`: durable Outbox for bot-side effects

Implemented bidding UI:

- collection bidding offers page is the primary operations surface for bid display and job targeting
- asks, tokens, and offers pages expose shared bidding target controls where write controls are allowed
- token detail renders the shared bidding automation panel inline for exact-token jobs
- reusable automation panel supports create, modify, activate, pause, and archive across target kinds
- price-tier panel supports collection-scoped tier settings, tier CRUD, ordering, and staged reapply

Backend mutation contract:

- CRUD writes desired job rows and command rows in one SQLite transaction
- backend publishes a JetStream wake-up only after the DB transaction commits
- JetStream is a speed-up signal, not authoritative state
- bot also scans pending command rows periodically for recovery

## Runtime Reconciliation

The bot treats DB job state as authoritative declared state.
After each command wake-up or recovery scan, it reloads enabled jobs before mutating live runtime state.

Command effects:

- `job_created` / `job_updated`: add or replace the in-memory job and run an immediate refresh when safe
- `job_paused` / `job_archived`: remove the job from scheduling and request active-offer cancellation
- `cancel_active_offer`: cancel the job-scoped active offer through the bot's OpenSea adapter

Reconciliation also updates watched collections:

- enabled jobs define which collection snapshots should poll
- enabled jobs define which OpenSea stream subscriptions should be active
- disabled or archived collections are unwatched so snapshot polling stops when no enabled jobs remain

## Bid Book Projection

The bid-book UI uses a read model optimized for display.
It is separate from bidder decision-making.

Projection tables:

- `trading_bidding_bid_book_rows`: materialized active bids by collection, source, scope, maker, unit price, quantity, validity, placement time, and display metadata
- `trading_bidding_collection_bid_book_state`: projection freshness, row count, duration, and last error per collection/source
- `trading_bidding_job_runtime_state`: bot-owned active-offer feedback and market decision state that lets backend bid-book reads connect declared jobs to live orders

Bot snapshot projection:

- runs inside the bidding runtime as a fire-and-forget sidecar after collection-offer snapshot refreshes
- only projects collections with enabled bidding jobs
- coalesces concurrent notifications per collection
- throttles projection by `BIDDING_BID_BOOK_PROJECTION_THROTTLE_MS` (default `15000`)
- does full transactional replacement for one collection
- logs row count and elapsed time on every successful projection
- records projection errors without failing snapshot refresh or bidder decisions

Backend source selection:

- use `bot_snapshot` when the collection has enabled bidding jobs, the bidding bot heartbeat is live, and projection metadata is fresh
- otherwise use `orders`
- standard/admin reads may overlay own declared jobs as `own_job_intent` rows before the bot has landed a matching market offer
- public single-collection reads stay market-only and do not expose local own-job context
- own market-position badges (`winning`, `draw`, `losing`) are attached only in fresh `bot_snapshot` mode and only from the bot-persisted runtime decision for the active order id
- the backend must not infer own bid position from bid-book rows or exact-scope price comparisons

Frontend labels:

- `bot_snapshot` is displayed as `competitive`
- `orders` is displayed as `normal`

`competitive` means the bid book is refreshed at the bot's competitive snapshot cadence.
`normal` means the bid book is refreshed through normal OpenSea order polling plus inbound stream updates.

Bid-book row materialization:

- `market_bid`: a real row from OpenSea order data, either the bot snapshot projection or canonical orders
- `own_job_intent`: a local declared job rendered as the user's intended bid while the runtime order is queued, paused, or not yet visible in market data
- queued or paused own-intent rows use a floor-ceiling price range because no single market order price exists yet
- runtime-active own-intent rows use the bot-persisted active order id and exact current price until the market row appears

## Bidding Automation UI

The bidding automation UI is a Userland control layer over declared DB jobs.
It does not change the bot's market-decision logic.

Targeting surfaces:

- `asks` and `tokens`: draft token or trait jobs from the current token-browser context
- `offers` / bid book: draft token, trait, or collection jobs from bid-book context
- token detail: edit or create the exact-token job inline

Target controls:

- `bid on traits`: uses the current trait filter or selected trait bucket as the declared trait target
- `bid on all tokens`: creates token jobs for every matching token across the full filtered result set
- `bid on this page`: narrows token jobs to currently loaded token cards
- `place collection bid`: creates or edits the collection-wide target
- `tiers`: opens collection price-tier management

Selection behavior:

- token-card selection is opt-in and uses `Ctrl` + left click or middle click on non-link card areas
- token-card links preserve browser-native `Ctrl` / middle-click new-tab behavior
- selected-card state feeds the bidding draft, selected-count text, and card visuals from one controller

Keyboard shortcuts:

- `1` / `2` / `3` / `4`: asks / offers / tokens / bidding
- `F`: trait filter panel
- `S`: bid scope
- `T`: price tiers
- `B`: floating bidding panel collapse/expand
- `C`: clear current bidding target

Button focus behavior is centralized through the frontend pointer-focus-release helper so clicked controls do not trap later page hotkeys.

## Price Tiers

Price tiers are collection-scoped reusable pricing definitions.
Jobs still store scalar `floor_wei`, `ceiling_wei`, and `delta_wei` for the bot.

Implemented behavior:

- root tiers are user-entered scalar floor values in Ether units
- child tiers can derive floor/ceiling from parent or floor values by absolute or percent deltas
- multiple child tiers can share the same parent, so one root can anchor independent strategy branches
- each tier owns its own delta
- collection settings store the default new-tier delta and tier selector presentation mode
- automation panel can select `manual` or a tier
- selected tier pricing fills the panel with resolved floor, ceiling, and delta values
- tier changes do not silently cascade into jobs
- staged reapply previews affected tier-backed jobs and applies only explicitly selected changes

Collection settings are stored through generic `collection_settings`; bidding owns typed setting keys but does not own a bidding-specific settings table.

## Orders Fallback

The orders fallback is passive display only.
It must not feed bot decisions.

For buy offers, fallback bid-book reads parse raw OpenSea payloads through the shared OpenSea bidding-offer parser:

1. try `raw_rest_data`
2. if REST payload parsing returns no offer, try `raw_stream_data`
3. if both fail, log the parser failure and skip the row

There is no legacy scope parser on the bid-book path.
This is a deliberate exception to the indexer raw-payload invariant because the shared bidding parser is currently the authoritative scope/unit-price parser for OpenSea bidding offers.

The `orders` table also stores bid-book-relevant normalized columns:

- `quantity`
- `source_encoded_token_ids`

The fallback lookup uses an active buy-offer index so collection bid-book reads do not rely on token-listing indexes.

## Scope Semantics

Supported bid-book scopes:

- `collection`: collection-wide bids
- `trait`: trait/criteria bids that can contain one or more trait criteria
- `token`: exact token bids
- `token_set`: offers over an encoded token-id set
- `unknown`: parser could not classify the scope safely

Token detail bid books show all applicable scopes because a token can receive collection, trait, token-set, and exact-token bids.

Collection bidding page scope controls:

- `token`: default view; show explicit token-scoped bids as token cards, one card per token, sorted by the token's highest explicit offer
- `traits`: show trait-scoped bids
- `collection`: show collection-wide bids only

Collection-wide rows are intentionally not mixed into the trait view.
Trait facet controls render in the `token` view with normal token-browser semantics and in the `traits` view with demand-bucket semantics.
The collection view does not render trait facet controls because selected token traits do not affect collection-wide bids.

The trait-scoped bidding page facet panel defaults to OR matching.
In OR mode, selected trait key-values and ranges match any criterion within a trait-scoped bid, so a user can quickly find all multi-trait combinations involving a given trait.
The separate `OR` / `AND` control switches join mode without clearing selected filters.
AND mode keeps the stricter behavior where the bid's full trait criterion set must exactly match the selected filters.

Token-scoped offer cards are paginated with the same `limit` / `cursor` contract as token browsing.
For signal quality, token-scoped offers below 10% of the current top collection-wide bid are hidden and excluded from per-card offer counts.
If no collection-wide bid exists, token-scoped offers are not floor-filtered.

## Secure Wallet Boundary

Desktop wallet custody is documented in `docs/desktop/03-wallet-keystore-and-bot-unlock.md`.

Trading-specific rules:

- private keys are Rust-owned until the exact bot startup moment
- key material is passed to Node through the one-shot stdin secret envelope only
- bot process args and env contain no private keys
- lifecycle events and runtime-state DB rows contain only non-secret metadata
- every bot restart requires a fresh unlock
- WETH allowance amount is configured in Ether units through `BIDDING_WETH_ALLOWANCE_ETH`
- onchain transactions use the shared EVM transaction policy from `@artgod/shared/evm/transactions`

## Config Surface

Dedicated OpenSea bot lanes:

- `OPENSEA_STREAM_SECRET_KEY`
- `OPENSEA_BIDDING_SECRET_KEY`
- `OPENSEA_SNAPSHOT_SECRET_KEY`
- `OPENSEA_SNIPER_SECRET_KEY` is reserved for later sniping work

Bidding runtime groups:

- snapshot cadence/freshness: `BIDDING_COLLECTION_OFFERS_*`
- bid-book projection: `BIDDING_BID_BOOK_PROJECTION_THROTTLE_MS`
- command reconciliation: `BIDDING_COMMAND_*`
- WETH allowance: `BIDDING_WETH_ALLOWANCE_ETH`
- EIP-1559 fee/nonce policy: `BIDDING_TX_*`

The indexer `OPENSEA_API_KEY` remains dedicated to indexer/offchain ingestion and should not be merged with bot keys by convenience.

## Deferred Work

- sniping runtime port
- persisted own-maker feedback for orders fallback `isOwn`
- token-card best-bid projection, limited to tokens with active listings
- real-time user-controlled WETH allowance updates
- SQL-backed token-offer pagination for larger offer books
