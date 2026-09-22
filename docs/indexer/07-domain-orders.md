# Orders Domain

The orders domain persists canonical order rows and maintains their fillability through dedicated update queues.

Primary file:

- `indexer/src/infra/domain/orders.ts`

Schema:

- `database/migrations/003_orders_schema.sql`
- `database/migrations/015_opensea_offchain_schema.sql`
- `database/migrations/016_offchain_source_scope.sql`
- `database/migrations/055_market_data_storage_lifecycle.sql`

## Inputs

The orders domain consumes four relevant job streams:

- `domain.orders.sync`
- `orders.upsert`
- `orders.update-by-maker`
- `orders.update-by-id`

`domain.orders.sync` is currently a no-op placeholder. Order state changes flow through the dedicated order queues instead of hidden range-wide invalidation logic.

Even so, the orders domain now enforces the bootstrap-anchor contract for onchain-driven maintenance:

- pre-anchor historical ranges must not invalidate current order state
- global maker triggers and explicit onchain update-by-id events are checked against the affected order row's `collection_id`
- offchain source-status updates are not anchor-gated because they are not replayed from historical onchain sync

## Canonical Order Model

`orders.upsert` carries the normalized ArtGod order DTO:

- order identity, `collectionId`, side, maker/taker, contract/token
- source scope (`token`, `collection`, `attribute`)
- source criteria root + normalized source schema
- local token-set linkage status (`none`, `resolved`, `unresolved`, `mismatch`)
- price, currency, validity window
- canonical Seaport protocol payload (`seaportData`)
- raw source kind (`stream` or `rest`)
- raw audit payload

Important invariant:

- canonical runtime logic uses normalized DTO fields and persisted `seaport_data_json`
- `raw_rest_data` and `raw_stream_data` are stored only for audit/debug in the indexer/order domain and are disabled by default with `PERSIST_RAW_DEBUG_PAYLOADS=false`
- trading bid-book fallback maps normalized order scope/schema fields and the
  scalar `protocol_address`, without parsing the full Seaport payload or raw
  REST/stream payloads; retained validators still use canonical Seaport data

## Status Model

The domain tracks two distinct statuses.

### `fillability_status`

Protocol/onchain executability:

- `fillable`
- `filled`
- `cancelled`
- `expired`
- `no-balance`
- `no-approval`
- `invalid`

### `source_status`

Marketplace/source-visible activity:

- `active`
- `inactive`
- `cancelled`
- `filled`
- `invalidated`
- `expired`
- `unknown`

They do not auto-collapse into one field.

Examples:

- source-active + no-balance
- source-inactive + fillable
- source-cancelled + still-fillable until an onchain/protocol check says otherwise

## Upsert Flow

1. Offchain ingest normalizes a stream or REST record.
2. `dispatchOffchainPayload()` publishes `orders.upsert`.
3. Domain worker admits a current observation and writes only changed canonical
   state; observation/validation freshness is separate from material changes.
4. If validation is requested and needed, domain worker publishes
   `orders.update-by-id` with `reason = "order"`. Recently validated identical
   upserts do not produce another validation. The job identity includes the
   collection, order, state revision and five-minute validation bucket.
5. Validation runs asynchronously from canonical order data already stored in SQLite.

`orders.upsert` writes optimistic defaults:

- `fillability_status = fillable`
- `source_status = active` (unless explicitly overridden)

The follow-up validation job corrects `fillability_status` after protocol checks run.

Unchanged payloads and statuses are SQL no-ops. Observation-only writes and
repeat validation have a five-minute freshness interval; explicit maker/state
change triggers still revalidate. A changed canonical upsert clears `validated_at`
in the same write that advances `state_revision`. If publishing validation fails,
an unchanged upsert retry still requests it until that revision has been validated.
A newer source observation does not erase that obligation: an older retry leaves
stored state untouched and requests validation of the current active revision.
Validation commits with a state-revision and
active-source guard, so a result obtained before an awaited RPC cannot overwrite
a newer cancellation. No SQLite reader or writer transaction stays open across
that RPC.

## Current-State Retention and Replay

`orders` is a current passive market projection, not a lifetime order archive.
The domain-owned rules are in `indexer/src/domain/order-retention.ts`:

- Passed `valid_until` is immediately eligible for removal. Filled/cancelled
  state has a one-hour grace period; source-inactive rows have a one-hour grace.
- Unknown-expiry orders have a 24-hour observation lifetime. A completed source
  reconcile records conservative collection observation freshness once.
- Temporary `no-balance` or `no-approval` is not terminal while the order is
  otherwise current. No count cap silently drops valid unexpired market offers.
- Expired orders, future timestamps beyond five minutes, missing collections
  and source updates older than the
  stored observation are rejected. Terminal cancellations cannot be undone by a
  later create; source inactivity is reversible with a newer observation.
- Queued creation observations are admitted for 24 hours, regardless of the
  order's expiry. This does not limit valid stored orders: fresh REST observations
  can still discover long-lived orders. Delayed cancellations of known orders
  remain effective beyond that cutoff.
- Small expiring `market_order_retirements` records fence premature terminal or
  inactive removal. Cancellation-before-create is covered, including extending
  its marker when a rejected create reveals a later validity deadline. Natural
  expiry fences its own replay without another permanent receipt archive.
- Chain rollback invalidates uncertain chain-derived terminal state, but preserves
  explicit OpenSea cancellations, including their compact removal records. This
  holds whichever cancellation arrives first, including after chain-derived
  state has been retired. Source-cancelled rows remain ineligible for current
  asks and follow the normal cleanup policy.
  User trading intent and own orders remain separate owners.

REST reconciliation streams active identities into connection-local temporary
SQLite tables. It stages missing identities once, updates 500 at a time and
rechecks eligibility between batches. New stream observations, including their
coalesced freshness bucket, win over older REST absence. Temporary membership
is closed on success, failure or collection removal; no whole-orderbook JS array
or durable reconcile receipt ledger is retained. Each deactivation batch also
refreshes today's existing listing price once per affected ask seller/NFT, in the
same transaction. Bids and orders whose eligibility changed do not cause a refresh.

Maker-update selection excludes expired orders in SQL and pages 500 candidates
at a time. The known-maker index likewise includes current/recoverable buy orders
only and iterates rows without materializing an intermediate result array.

Startup recovery rebuilds legacy market rows before writers start; a single
domain-worker maintenance owner selects obsolete orders through indexes every
20 minutes. Its pass yields between 500-row batches and stops starting batches
at a two-second elapsed budget. Already-completed startup recovery does not
repeat that online sweep. Unfinished online work resumes after a 30-second pause
with the same limits. Cleanup and price batches alternate across passes; a
completed price pass waits 20 minutes before becoming due again during catch-up.
Once caught up, or after
a failure, the next pass waits 20 minutes. Passes never overlap.
Order cleanup does not change extension artifacts or synthetic-token retirement
records. Synthetic unminted IDs cannot have valid orders and do not need a
historical-order marker.
See [storage recovery](../development/03-sqlite-storage-and-recovery.md).

## Seaport Validation

The Seaport validator lives in `indexer/src/application/offchain/seaport-validate.ts` and runs from canonical `seaport_data_json`.

Current validation flow:

1. Parse canonical Seaport data from the order row.
2. Reconstruct the Seaport order hash locally and compare with `order.id`.
3. Signature handling:
    - stream-derived order with signature -> verify typed-data signer
    - stream-derived order without signature -> warn and continue
    - REST-derived order -> no signature expectation
4. Check time window with local wall clock.
5. Read Seaport `getOrderStatus(orderHash)`.
6. Read Seaport `getCounter(offerer)`.
7. Resolve conduit approvals via ConduitController + local conduit cache.
8. Check sell-side ownership/approvals or buy-side balance/allowance.

RPC-dependent validation steps are guarded with `try/catch`. Hard RPC/helper failures are logged and converted into `invalid`, not left to DLQ by default.

## Source Scope and Token Sets

The orders domain distinguishes source scope from local token-set linkage.

### Token orders

- `source_scope_kind = token`
- no token-set lookup required
- `local_token_set_status = none`

### Collection offers

- `source_scope_kind = collection`
- `identifierOrCriteria = 0` is valid wildcard protocol semantics
- collection-wide offers are persisted even though local collection Merkle roots are non-zero

### Attribute / trait offers

- persisted even when local token-set linkage fails
- local linkage may be:
    - `resolved`
    - `unresolved`
    - `mismatch`
- `source_criteria_root` is preserved for diagnostics and future repair work

The key rule is: local token-set resolution failure or mismatch must not drop otherwise valid source orders.

### Token-set materialization

The token-set registry materializes collection and attribute schemas from the
canonical local collection state:

- attribute key/value pairs are trimmed, deduplicated, and sorted before the
  normalized schema JSON is hashed with SHA-256;
- attribute schemas resolve membership with AND semantics across canonical
  metadata traits only; extension-owned browse traits do not silently change
  marketplace criteria membership;
- collection schemas resolve membership from the collection's canonical
  balance rows;
- only canonical decimal token IDs inside the `uint256` range can become
  Seaport criteria leaves;
- each leaf is the Keccak-256 hash of its 32-byte token ID, leaves and pairs
  sort deterministically, and an odd leaf is promoted unchanged;
- `token_sets` stores the normalized schema, schema hash, Merkle root, and
  `list:<contract>:<root>` identity; `token_sets_tokens` stores membership
  under both token-set identity and schema hash.

An empty local set is `unresolved`. For an attribute offer, a computed root
that differs from the source criteria root is `mismatch`. Only a matching
resolution attaches `token_set_id` and `token_set_schema_hash` to the order.
Collection offers retain their protocol wildcard semantics independently of a
non-zero local collection-set root.

## Order Update Queues

### `orders.update-by-id`

Used for:

- explicit fill/cancel status changes
- offchain source-status changes (`cancelled`, `filled`, `invalidated`, `active`)
- post-upsert validation (`reason = "order"`)

For `reason = "order"`, the handler loads the canonical `orders` row and validates it as a Seaport order if `seaport_data_json` exists.

### `orders.update-by-maker`

Maker triggers are re-validation hints, not unconditional cancels.

Current maker trigger scoping is split explicitly:

- `nft-transfer`, `nft-approval`, `item_sold`, `item_transferred`
    - token-scoped payload
    - includes `collectionId + tokenId`
    - re-validate exact-token sell orders for that maker
- `nft-approval-for-all`
    - collection-scoped payload
    - includes `collectionId`
    - re-validate active sell orders in that collection for that maker
- `erc20-balance`, `approval-change`
    - global payload
    - re-validate WETH-denominated buy orders for that maker
- `order-counter`
    - global payload
    - re-validate all Seaport orders for that maker

These updates only change `fillability_status`.

Anchor rule:

- token-scoped and global onchain maker triggers may only mutate orders when the relevant collection can project current state at that block
- the sync worker applies coarse anchor gating during fanout
- the orders domain applies the final per-order/per-collection guard for broader triggers that are not collection-scoped at the sync boundary

## Bidder Index (Quiet Default)

WETH transfer/approval logs can trigger maker updates, but to avoid queue spam the sync path gates them behind a bidder index:

- the index is refreshed from current buy orders
- if the index is not ready or empty, WETH-triggered maker updates are not emitted
- when non-empty, only indexed makers receive WETH-triggered updates

## Current Limits and Future Direction

- `domain.orders.sync` is still a placeholder.
- Validation semantics are intentionally split between source visibility and protocol executability.
- Local time is still used for active/expired checks.
- Raw audit payloads are not runtime input. The backend's indexed-orders
  bid-book fallback uses normalized order columns and canonical source-schema
  JSON, not the optional raw debug payload.
- Partial fill quantity progression is not modeled; fills can make an order
  terminal, but the order row does not expose a remaining-quantity state machine.
- Ingest fails closed on local criteria linkage: empty membership is
  `unresolved`, a root difference is `mismatch`, and neither state attaches a
  local token-set id. There is no automatic redrive that rematerializes those
  orders after canonical metadata coverage changes, and unusual numeric payload
  forms still need a deterministic parsing/repair policy.
- Maker revalidation watches WETH `Transfer` and `Approval`; native WETH
  `Deposit` and `Withdrawal` triggers are not decoded separately yet.
