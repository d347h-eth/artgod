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
- One `market_order_retirements` row per order protects against delayed input;
  there is no per-message receipt archive. It stores the observation cutoff,
  nullable order `valid_until`, and one calculated cleanup deadline, `expires_at`.
- Inactive markers expire at the earlier of order expiry and observation cutoff
  plus 24 hours. Cleanup or redelivery does not restart that replay window.
- Cancellation/filled markers protect against fresh REST observations too. With
  known expiry, they last until that deadline plus the existing one-hour grace.
  Without it, they use a 24-hour fallback from first processing; repeat delivery
  does not extend the fallback. This fallback is not proof of natural expiry.
- OpenSea cancellation and sale updates carry optional `expiration_date` through
  normalization and queueing. Missing or malformed optional expiry does not
  discard the cancellation. Later expiry evidence can shorten or extend an
  unknown-expiry fallback without admitting the rejected order. Conflicting
  known deadlines conservatively retain the later expiry.
- Known expiry is preserved when a full order is removed. Markers whose calculated
  deadline has already passed are not inserted; normal indexed maintenance removes
  expired markers. Natural order expiry also rejects replay directly.
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

## REST Reconciliation Freshness

`OpenSeaReconcilePolicy` owns the automatic age thresholds: periodic and retry
requests use `OPENSEA_RECONCILE_INTERVAL_MS` (15 minutes by default); startup
requests use `OPENSEA_STALE_START_THRESHOLD_MS` (30 minutes). A successful
completion exactly at the cutoff is due. The SQLite collection adapter compares
UTC epoch instants and uses the latest successful initial snapshot or
reconciliation. Never-refreshed collections are due; starts, stream events and
failed attempts do not advance successful freshness.

The scheduler selects live collections with an OpenSea identity, oldest refresh
first, with never-refreshed collections first and collection ID breaking ties.
The reconciliation use case repeats the same metadata query when each job is
consumed. Automatic envelopes mean "ensure this collection is fresh": requests
satisfied while queued return before inserting a run, creating temporary
membership, publishing raw orders or writing collection state. Normal worker ACKs
drain these obsolete hints, including old retries, without a queue purge. An old
request still runs if the collection remains stale; a previously attempted job
ID is not evidence of success. Removed or non-live collections are ineligible.

`manual` explicitly forces a refresh for an eligible collection and retains
that intent if it fails and retries. There is no new manual-refresh UI.
Listings and offers still complete together, with listings first. Successful
freshness is recorded only after the full scan and source-state reconciliation
complete. This does not imply downstream upsert/validation has finished.

The worker stays serial and renews its 30-second ACK lease every 10 seconds.
The existing durable consumer settings are reconciled on startup. Start,
completion and retry logs include the job ID, reason, attempt, collection and
run ID; completion/retry also include duration. Already-satisfied hints produce
debug logs and no persisted skip history.

A 15-minute scheduling tick is not an exact 15-minute completion guarantee:
eligibility may wait until the next tick, then for serial work and API capacity.
Execution-time suppression coalesces useful work, not physical queue envelopes.
No schema or persisted payload change is required for existing alpha queues.

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

Singleton RPC-dependent validation retains its existing `try/catch` behavior:
hard RPC/helper failures are logged and converted into `invalid`.

Maker WETH bids use `createSeaportValidationBatchFactory` through the injected
`MakerValidationBatchFactory` port. Full validation remains per order, but
counter, allowance and balance reads share successful/in-flight results within
one chain snapshot. Keys include block identity, contract, function and arguments;
allowances remain distinct by spender. Order status, terms, hash and optional
signature checks are retained. Existing conduit-cache behavior is unchanged.

`ORDER_VALIDATION_BATCH_POLICY` caps a context at 100 orders and stops admitting
orders after five seconds. A context pins every contract read to a current block
at least as recent as the trigger. Before committing the bounded results, the
worker fetches that block afresh and checks its hash, the head, and lifetime:
30 seconds maximum context lifetime, a block no more than 60 seconds old, and
head advancement of at most two blocks. The next context starts afresh. RPC,
stale-head and reorg failures discard the uncommitted context and retry the job;
they cannot mark a wallet's bids invalid. Actual protocol terminal/invalid
decisions still apply. Writes retain revision, active-source and bootstrap-anchor
guards, with no SQLite transaction spanning RPC calls.

Non-WETH and singleton validation retain their current RPC path.

### Durable maker progress

The domain runtime invokes the `RevalidateMakerOrders` application use case with
the original job identity and broker delivery origin. An additive
`maker_order_revalidation_runs` table owns the request, finite pass boundary,
cursor, completed count, failures and lease/version fence. Candidate pages use
the existing indexed queries; the initial maximum order ID and rowid exclude
later admissions. New canonical orders retain their own validation follow-up;
a later maker trigger starts its own pass, including orders behind an older cursor.

Each bounded context commits its order effects and cursor in one SQLite write
transaction. Removed, expired, source-terminal and anchor-ineligible candidates
are intentionally resolved. A still-actionable changed revision rejects the
checkpoint, preserving the previous cursor for fresh validation on retry. RPC
awaits stay outside database transactions. A two-minute lease, renewed every
30 seconds, fences duplicate executors; lease contention defers the delivery
without treating the scheduling wait as an execution failure.

Restart reacquires a fresh RPC snapshot and resumes after the last committed
cursor. Completion before ACK is recognizable on redelivery. Completed receipts
are deleted in bounded batches only when the matching stream incarnation and
consumer ACK floor prove the recorded delivery cannot be replayed by that
consumer. Missing broker origin does not expire by time. Fresh publications
after receipt cleanup are new admissions; they never skip current validation.

Each delivery admits at most 100 candidates and five seconds of new validation
work, then finishes its in-flight RPC under the provider timeout. The checkpoint
transaction also replaces the run's single outbox continuation. The next step
joins the same queue behind ready work; the current delivery can ACK because
unfinished work already has durable ownership. Step identity and lease fences
make duplicate publication/delivery harmless. Successful steps start with a fresh
delivery attempt; only failed execution/publication contributes to retry state.

A five-second recovery poll rotates through at most 25 idle pending runs, after
a 30-second grace period. It repairs absent or terminally failed outbox entries.
For sent entries it checks the broker stream incarnation, publication sequence
and consumer ACK floor: sent alone is not proof of pending or completed work.
An active lease or changed step prevents a stale recovery decision from replacing
newer work. The outbox holds at most one continuation per unfinished run; completed
receipts still use the replay-boundary cleanup above, not a short TTL.

Continuations retain `orders.update-by-maker` and the complete original payload,
adding only `continuation: { runId, step }`. Older consumers can conservatively
perform the original scan; they cannot resume the saved cursor. This is a source
compatibility bridge, not verified native downgrade support. Keep SQLite/NATS
backups and deployed worker artifacts aligned; do not restore either store alone.
Legacy standalone `SqliteOrdersDomain.handleOrderUpdateByMaker` remains for
existing callers and baseline tests; runtime scheduling belongs to the application
use case. The separate by-ID backlog is not accelerated by these maker changes.

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
