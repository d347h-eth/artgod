# Bidding Runtime and Jobs

This document is the current-state reference for ArtGod bidding.
Progress/history notes remain in `docs/progress/trading/*`.

## Status

Bidding is the first trading runtime implemented in ArtGod.

Current implementation:

- the real bidding runtime runs from `trading/dist-desktop/bidding-bot-runtime.mjs`
- declared bidding jobs are stored in SQLite
- backend/Userland expose CRUD for token-scoped jobs
- running bots reconcile DB job commands without restart
- bid-book UI reads either the bot snapshot projection or canonical orders fallback
- sniping remains staged but not functionally ported

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

## Job Persistence

SQLite is the only supported declared-job source.
The temporary JSON job file source has been removed.

Primary tables:

- `trading_jobs`: common declared job envelope for bidding and future sniping
- `trading_bidding_job_specs`: bidding strategy fields (`floor_wei`, `ceiling_wei`, `delta_wei`, quantity, trait criteria)
- `trading_bidding_job_runtime_state`: bot-owned active-offer/runtime state for cancellation and diagnostics
- `trading_job_commands`: durable Outbox for bot-side effects

Implemented first-pass UI:

- collection bidding page lists jobs for the collection and supports inline update/archive actions
- token detail page supports create/update/archive for token-scoped jobs
- collection-scoped and trait-scoped job creation UI is intentionally deferred

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

Frontend labels:

- `bot_snapshot` is displayed as `competitive`
- `orders` is displayed as `normal`

`competitive` means the bid book is refreshed at the bot's competitive snapshot cadence.
`normal` means the bid book is refreshed through normal OpenSea order polling plus inbound stream updates.

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

- `collection`: show collection-wide bids only
- `traits`: show trait-scoped bids; selected trait filters must match the bid's full trait criterion set

Collection-wide rows are intentionally not mixed into the trait view.

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
- collection-scoped and trait-scoped job creation UI
- persisted own-maker feedback for orders fallback `isOwn`
- token-card best-bid projection, limited to tokens with active listings
- real-time user-controlled WETH allowance updates
