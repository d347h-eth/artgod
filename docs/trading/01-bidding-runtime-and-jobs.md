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
- Broad collection/trait offer stream events and exact-token offer stream events are coalesced before bidder refresh so flood traffic cannot monopolize command processing.
- User-driven job commands stay serial at the durable command layer, but their immediate job refresh uses command-priority OpenSea reads/writes and is not queued behind hot-refresh or full-scan work for unrelated jobs.
- Command reconciliation may complete an enabled-job command without another OpenSea pass when the current bot process has already verified an active order for the same job revision.
- The snapshot lane polls every 60 seconds and hot-path callers force a blocking refresh when the snapshot is older than the configured stale threshold.
- Snapshot refresh entrypoints are serialized/deduped by the snapshot service.
- Heavy collection all-offers snapshots are a known scaling pressure; detailed evidence and the target adaptive snapshot refactor are tracked in `docs/progress/trading/07-bidding-market-snapshot-scaling.md`.
- Job execution remains per-job serialized.
- Token trait matching reads normalized `token_attributes` joins; bidding hot-refresh does not parse `token_metadata.attributes_json` or `token_metadata.raw_json`.
- Marketplace token bidding targets must be canonical `tokens` rows. Extension-synthetic tokens can be shown in browsing surfaces, but frontend bidding selection and backend job mutation exclude them before bot commands exist.
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
3. mark previously tracked active offers as unverified for enabled bidding jobs
4. load enabled bidding jobs from SQLite
5. wire OpenSea lanes, metadata lookup, WETH balance/allowance, transaction policy, and logging adapters
6. emit `bot_bootstrapping` before long allowance/snapshot/price bootstrap work
7. approve configured WETH allowance when `BIDDING_WETH_ALLOWANCE_ETH > 0`
8. bootstrap authoritative collection-offer snapshots and current prices
9. replay already-committed job commands while stream listeners and snapshot polling are still inactive
10. start OpenSea stream listeners and steady-state snapshot polling from the post-command enabled-job set
11. start the continuous job scan loop, command reconciliation loop/listener, and heartbeat
12. start the low-cadence failed-cancellation reconciliation loop
13. emit `bot_ready` only after bootstrap is complete

`trading_bot_runtime_state` stores non-secret bot heartbeat state.
Backend bid-book reads use it to decide whether the bot snapshot projection can be treated as live.
Active-order evidence restored from a prior bot process is rendered as `verifying` until the current process proves, replaces, or clears that order through OpenSea-backed runtime work.

## Current Runtime Mode

The current bidding runtime is optimized around a background-maintained market
view plus narrow command and hot-refresh lanes.

Command reconciliation:

- claims ordered command rows one at a time
- reloads the authoritative job declaration before mutating in-memory bidder state
- replays committed startup commands before OpenSea stream subscriptions and
  steady-state snapshot polling start
- updates watched snapshot collections and direct stream subscriptions after
  command effects
- can finish an enabled-job command idempotently when the bot already verifies
  an active order for the same job declaration

Hot refresh:

- treats stream events as signals only
- coalesces broad collection/trait events and exact-item events separately
- keeps the highest-price queued event per signature
- uses cooldowns from `BIDDING_HOT_REFRESH_*`
- cancels queued work on runtime shutdown
- summarizes no-effect logs so spammed streams stay observable without
  dominating logging or CPU

Offer discovery:

- token jobs read live exact-token offers, cached broader snapshot offers, and a
  best-offer fallback
- collection jobs prefer cached collection snapshots and use live collection
  pagination only when no usable snapshot exists
- competitive trait jobs remain on live collection and trait endpoint reads
  because they need collection-wide context plus trait-bucket fan-out
- full collection all-offers snapshots still back broad competition context and
  bid-book projection, which is the next scaling boundary for heavily spammed
  collections

## Runtime Logging

The bidding bot emits JSON Lines through the shared ArtGod logger. Every
operator-facing runtime log sets stable `component` and `action` fields for
Alloy/Loki labels, and puts job, collection, token, offer, transaction,
snapshot, retry, and error details into dedicated JSON payload fields.

Lifecycle payloads such as `bot_bootstrapping` and `bot_ready` remain the
supervisor control protocol and are separate from diagnostic log entries.
Snapshot bootstrap emits collection start/progress events and repeats the current
collection on the bot heartbeat cadence while the initial all-offers fetch is
running.
Startup command replay emits the `command_reconciliation` bootstrap phase so the
supervisor can distinguish command work from a dead startup. During startup
command replay, each claimed command emits immediate start/finish progress and
the current command is re-emitted on the bot heartbeat cadence while it is still
running. Current-price bootstrap logs each token candidate start and completion.

No-effect hot-refresh logs are summarized per collection/scope/type/reason so
irrelevant stream flood remains visible without emitting one log line per event.

Bot logs must never include wallet private keys, secret-envelope payloads,
OpenSea secret keys, or raw OpenSea request/stream payloads.

## Job Persistence

SQLite is the only supported declared-job source.
The temporary JSON job file source has been removed.

Primary tables:

- `trading_jobs`: common declared job envelope for bidding and future sniping
- `trading_bidding_job_specs`: bidding strategy fields (`floor_wei`, `ceiling_wei`, `delta_wei`, quantity, trait criteria)
- `trading_bidding_job_runtime_state`: bot-owned active-offer/runtime state for cancellation and diagnostics
- `trading_bidding_order_cancellations`: bot-owned active-offer cancellation lifecycle facts for bid-book visibility and stale-index suppression
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
- `cancel_active_offer` is idempotent when neither the command payload nor the recovered job state has a tracked active OpenSea order id; the bot completes the command without probing OpenSea by target
- `cancel_active_offer` is also idempotent when OpenSea active-offer discovery and direct order recovery prove the tracked order id is already absent; the bot records the cancellation as completed and clears runtime state
- inconclusive direct order recovery keeps the command retryable because the bot cannot prove whether the order is still live
- terminal cancellation failures are written back to `trading_bidding_order_cancellations` so the bid book renders `cancel failed` instead of leaving an unresolved `canceling` row
- failed cancellation rows are periodically rechecked by `BIDDING_FAILED_CANCELLATION_RECONCILE_MS` and marked completed only after OpenSea proves the tracked order is absent

Reconciliation also updates watched collections:

- enabled jobs define which collection snapshots should poll
- enabled jobs define which OpenSea stream subscriptions should be active
- disabled or archived collections are unwatched so snapshot polling stops when no enabled jobs remain

OpenSea HTTP retry behavior is shared with the main app config through
`OPENSEA_HTTP_RETRY_*` and `OPENSEA_RATE_LIMIT_*`. The bidding OpenSea adapter
also classifies stable OpenSea target validation errors, such as unsupported or
missing token/trait targets, as non-retryable so one bad target does not stall
the ordered command queue behind repeated SDK retries.

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
- throttles projection by `BIDDING_BID_BOOK_PROJECTION_THROTTLE_MS`
- treats bot snapshots as usable only while `BIDDING_RUNTIME_HEARTBEAT_STALE_MS` and `BIDDING_BID_BOOK_SNAPSHOT_STALE_MS` are fresh
- does full transactional replacement for one collection
- logs row count and elapsed time on every successful projection
- records projection errors without failing snapshot refresh or bidder decisions

Backend source selection:

- use `bot_snapshot` when the collection has enabled bidding jobs, the bidding bot heartbeat is live, and projection metadata is fresh
- otherwise use `orders`
- standard/admin reads may overlay own declared jobs as `own_job_intent` rows before the bot has landed a matching market offer
- public single-collection reads stay market-only and do not expose local own-job context
- own market-position badges (`winning`, `draw`, `losing`) are attached only from the bot-persisted runtime decision for the active order id
- prior-process active-order evidence can keep an own row visible, but strategy badges stay hidden and the row is marked `verifying` until the running bot verifies the order in the current process
- runtime-backed own rows prefer the bot-persisted active order timing even when the visible row is backed by a projected or indexed market order
- when a job revision supersedes an active order, the old exact order remains visible as a lifecycle own row while the current revision appears as a queued intent row
- completed own cancellations suppress stale indexed own order rows, with a short `cancelled` confirmation row before disappearance
- the backend must not infer own bid position from bid-book rows or exact-scope price comparisons

Frontend labels:

- `bot_snapshot` is displayed as `competitive`
- `orders` is displayed as `normal`

`competitive` means the bid book is refreshed at the bot's competitive snapshot cadence.
`normal` means the bid book is refreshed through normal OpenSea order polling plus inbound stream updates.

Bid-book row materialization:

- `market_bid`: a real row from OpenSea order data, either the bot snapshot projection or canonical orders
- `own_job_intent`: a local declared job or own active-order lifecycle row rendered from backend-owned runtime/cancellation facts
- queued or paused own-intent rows use a floor-ceiling price range because no single market order price exists yet
- replacing, canceling, cancel failed, and cancelled own-intent rows use the real active order id and exact current price
- runtime-active own-intent rows use the bot-persisted active order id and exact current price until the market row appears
- bid-book tables show floor and ceiling columns only when visible rows carry bid-limit or range data

## Bidding Automation UI

The bidding automation UI is a Userland control layer over declared DB jobs.
It does not change the bot's market-decision logic.

Targeting surfaces:

- `asks` and `tokens`: draft token or trait jobs from the current token-browser context
- holder-token browser: draft token jobs from the current owner-constrained token-browser context
- `offers` / bid book: draft token, trait, or collection jobs from bid-book context
- token detail: edit or create the exact-token job inline

Target controls:

- `bid on traits`: uses the current trait filter or selected trait bucket as the declared trait target
- `bid on all tokens`: creates token jobs for every matching token across the full filtered result set
- owner-token pages apply the current owner as an additional token-browser selection constraint for token jobs
- token-scoped bidding keeps only canonical marketplace-addressable tokens; unsupported synthetic token cards are not selectable as bidding targets
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

For buy offers, fallback bid-book reads map normalized `orders` columns into bid-book rows. It does not parse `raw_rest_data` or `raw_stream_data`.

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
- bid-book projection, backend freshness, and UI live refresh: `BIDDING_BID_BOOK_*`
- bidding job scan sleep: `BIDDING_SCAN_SLEEP_MS`
- bidding hot-refresh backpressure: `BIDDING_HOT_REFRESH_*`
- bot runtime liveness: `BIDDING_RUNTIME_HEARTBEAT_*`
- command reconciliation: `BIDDING_COMMAND_*`
- failed cancellation recovery: `BIDDING_FAILED_CANCELLATION_RECONCILE_MS`
- WETH allowance: `BIDDING_WETH_ALLOWANCE_ETH`
- EIP-1559 fee/nonce policy: `BIDDING_TX_*`

The indexer `OPENSEA_API_KEY` remains dedicated to indexer/offchain ingestion and should not be merged with bot keys by convenience.

## Deferred Work

- sniping runtime port
- persisted own-maker feedback for orders fallback `isOwn`
- token-card best-bid projection, limited to tokens with active listings
- real-time user-controlled WETH allowance updates
- SQL-backed token-offer pagination for larger offer books
