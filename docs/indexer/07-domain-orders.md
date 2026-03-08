# Orders Domain

The orders domain persists canonical order rows and maintains their fillability through dedicated update queues.

Primary file:

- `indexer/src/infra/domain/orders.ts`

Schema:

- `database/migrations/003_orders_schema.sql`
- `database/migrations/015_opensea_offchain_schema.sql`
- `database/migrations/016_offchain_source_scope.sql`

## Inputs

The orders domain consumes four relevant job streams:

- `domain.orders.sync`
- `orders.upsert`
- `orders.update-by-maker`
- `orders.update-by-id`

`domain.orders.sync` is currently a no-op placeholder. Order state changes flow through the dedicated order queues instead of hidden range-wide invalidation logic.

## Canonical Order Model

`orders.upsert` carries the normalized ArtGod order DTO:

- order identity, side, maker/taker, contract/token
- source scope (`token`, `collection`, `attribute`)
- source criteria root + normalized source schema
- local token-set linkage status (`none`, `resolved`, `unresolved`, `mismatch`)
- price, currency, validity window
- canonical Seaport protocol payload (`seaportData`)
- raw source kind (`stream` or `rest`)
- raw audit payload

Important invariant:

- canonical runtime logic uses normalized DTO fields and persisted `seaport_data_json`
- `raw_rest_data` and `raw_stream_data` are stored only for audit/debug

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
3. Domain worker writes the canonical `orders` row.
4. If `validateAfterUpsert = true`, domain worker publishes `orders.update-by-id` with `reason = "order"`.
5. Validation runs asynchronously from canonical order data already stored in SQLite.

`orders.upsert` writes optimistic defaults:

- `fillability_status = fillable`
- `source_status = active` (unless explicitly overridden)

The follow-up validation job corrects `fillability_status` after protocol checks run.

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

## Order Update Queues

### `orders.update-by-id`

Used for:

- explicit fill/cancel status changes
- offchain source-status changes (`cancelled`, `filled`, `invalidated`, `active`)
- post-upsert validation (`reason = "order"`)

For `reason = "order"`, the handler loads the canonical `orders` row and validates it as a Seaport order if `seaport_data_json` exists.

### `orders.update-by-maker`

Maker triggers are re-validation hints, not unconditional cancels.

Current maker trigger scoping:

- `nft-transfer`, `item_sold`, `item_transferred`
  - re-validate exact-token sell orders for that maker
- `erc20-balance`, `approval-change`
  - re-validate WETH-denominated buy orders for that maker
- `order-counter`
  - re-validate all Seaport orders for that maker

These updates only change `fillability_status`.

## Bidder Index (Quiet Default)

WETH transfer/approval logs can trigger maker updates, but to avoid queue spam the sync path gates them behind a bidder index:

- the index is refreshed from current buy orders
- if the index is not ready or empty, WETH-triggered maker updates are not emitted
- when non-empty, only indexed makers receive WETH-triggered updates

## Current Limits

- `domain.orders.sync` is still a placeholder.
- Validation semantics are intentionally split between source visibility and protocol executability.
- Local time is still used for active/expired checks.
- Raw audit payloads are intentionally not part of runtime decision-making.
