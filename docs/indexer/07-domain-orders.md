# Orders Domain

The chain coordinator owns accepted current state. Sources provide order
observations and invalidation hints; the validator reads a checkpoint supplied
by that coordinator. Neither source delivery nor validation may advance sync.
See [sync](04-sync-pipeline.md), [recovery](06-reorg-handling.md), and
[storage](05-storage-and-schema.md) for the shared authority boundary.

Primary owners:

- `domain/order-observation.ts`: declaration identity, structural readiness,
  signed validity and independent source availability.
- `infra/domain/orders.ts`: atomic observation admission and guarded projection.
- `application/orders/validate-order-demand.ts`: the sole full RPC validator.
- `infra/orders/sqlite-order-validation-demand.ts`: causal admission, leases,
  proof completion, freshness scheduling and rollback invalidation.
- `application/orders/revalidate-maker.ts`: bounded scope-to-demand expansion.
- `shared/database/order-evidence.ts`: positive evidence required by current asks
  and the backend indexed bid-book fallback.

## Inputs

`orders.upsert` carries a normalized declaration. The lifecycle consumer
passes source updates through the same atomic owner. A source update must identify
its source; an onchain hint must identify an accepted block number and hash.
Canonical sync retains essential order and maker invalidations in its writer,
before publishing applied progress. Canonical by-ID effects require no queue message. A maker scope with eligible
orders retains one compact continuation in that same transaction; an irrelevant
maker creates neither a run nor an outbox message.

Historical acquisition emits facts/projection work without current-order effects.

## Processing ownership and retained state

| Owner               | Durable responsibility                                                            | Completion                                                                        |
| ------------------- | --------------------------------------------------------------------------------- | --------------------------------------------------------------------------------- |
| Source admission    | Immutable declaration, per-source observation and ordinary demand in one writer   | ACK after retention; no receipt lookup or validation permit                       |
| Chain coordinator   | Connected shared/scoped applied prefixes and essential invalidations              | One atomic facts/effects/progress/outbox commit                                   |
| Maker expansion     | Finite selection boundary, cursor, generation and continuation                    | Cursor advances only with per-order demand retention                              |
| Ordinary validation | Ready-only claims, supplied checkpoint, exact-hash snapshot and fenced completion | Result, independent proof, demand coverage and projection refresh commit together |
| Outbox/recovery     | Publication and continuation receipts with replay protection                      | Publication is distinct from completed validation                                 |
| Maintenance         | Bounded stale/expired observation cleanup and head-sample retention               | Never performs RPC or invents positive proof                                      |

Demand polling resumes after restart without a broker wakeup. Maker continuation
recovery and broker replay receipts remain necessary scheduling/deduplication
mechanisms; they no longer own a separate RPC validator. The former
`order_execution_requirements` receipt prerequisite and executor are removed.

## Canonical Order Model

`orders` retains normalized identity, scope, signed Seaport terms, original NFT
quantity and materialized protocol state. Incoming signed terms must hash to the
order identity and maker. A retained declaration cannot change its chain,
collection, protocol domain, maker or signed components. Missing terms/signature
may be enriched. Signed validity bounds take precedence over source metadata.
Current persistence has one global order-hash key: conflicting cross-chain use
is rejected explicitly; this change does not introduce a multichain orderbook.

`order_source_observations` retains one compact observation per order/source.
Source-reported quantity and source timestamp are observations, not remaining
quantity or chain authority. Equivalent retransmissions coalesce even when a
second source arrives between them. Local admission sequences order causal work;
remote clocks never select checkpoints or advance another source's state.
Raw REST/stream payloads remain opt-in debug storage and are not runtime input.

## Status Model

### `fillability_status`

The materialized protocol result is `unvalidated`, `fillable`, `filled`,
`cancelled`, `expired`, `no-balance`, `no-approval`, or `invalid`.
A `fillable` value alone does not establish current executability.

### `source_status`

Per-source records retain source vocabulary, including activity and withdrawal.
The order row aggregates availability as `active` when any source is active,
otherwise `inactive`. Withdrawal by OpenSea does not revoke another source's
availability and never becomes an onchain cancellation. A create/REST copy does
not undo that same source's explicit cancellation; an explicit subsequent source
update can reopen it. Chain rollback does not modify source observations.
Completed REST crawls withdraw absent source observations through the same
source-observation owner. A changed withdrawal retains causal validation demand
when another source keeps the order available; source facts, demand and current
asks change atomically. Selection and each bounded write recheck that
source's local freshness; another source's recent activity cannot hide an
OpenSea withdrawal. Repeated observations coalesce local freshness writes
without creating another validation admission. Reconciliation leaves that
freshness bucket alone so observations arriving during a crawl win.

## Upsert Flow

1. Normalize the source record through the existing source adapter.
2. Bind the declaration to its collection, signed NFT side/contract/identifier
   and immutable order identity. Derive supported quote currency and exact unit
   price from signed payment terms, then merge immutable terms.
3. Atomically retain the per-source observation, declaration and causal demand.
4. Wait for a coordinator head sample captured after admission, then for shared
   and collection applied progress to cover that sample.
5. Claim ready demand, perform full validation, and commit fenced evidence.

New declarations start `unvalidated`, with unknown canonical remaining quantity
represented by null. Structurally incomplete declarations remain observed and
pending but cannot claim RPC capacity. There is no optimistic `fillable` seed or
upsert validation opt-out. A source sale never zeroes quantity, including a
known full-only order. Existing results remain as observations while new demand
is pending; positive readers reject evidence not covering that demand.
An inactivity-retirement timestamp cannot reject a new source merely because it
arrives in the same second as cleanup. Source-specific withdrawal and immutable
expiry still apply.

### Coalesced ordinary validation

Source requirements carry stable observation identity and a local monotonic
admission sequence. Canonical requirements carry accepted block number/hash.
Coalescing preserves both. A source admitted during a head read waits for a later
sample; source timestamps cannot satisfy that barrier. Samples freeze the first
successful post-admission height and bind its hash to accepted shared history.

Claims capture order revision, demand generation, chain revision, lease and one
coherent collection/shared checkpoint. A newer observation can remain pending
while an older valid claimed generation finishes. Advancing sync from N to N+1
alone does not invalidate a coherent result at N. Changed order state, newer
proof, lost lease, rollback, disputed history or insufficient coverage does.

The demand owner admits periodic freshness work independently of source arrivals.
Two ordinary executors share FIFO capacity; pages contain at most 100 ready
orders. A snapshot stops accepting work after five seconds and expires after
30 seconds. Unready demand acquires neither a validation permit nor a broker
unacknowledged slot. Per-order retry/isolation prevents one failing declaration
from repeatedly blocking unrelated work. Local quota deferral releases claims;
RPC uncertainty cannot become a protocol-invalid result.
Future-start declarations retain ordinary pending demand without occupying
leases or RPC capacity. Claims become ready when the accepted shared/collection
checkpoint reaches the signed start time, independently of source replay or
process restart. Full validation evaluates the signed validity interval against
that checkpoint's timestamp; local wall time still bounds work lifetimes,
freshness and conservative expiry. A not-yet-started result is nonterminal,
while the signed end time remains exclusive and terminal.

## OpenSea Sale Hints

A source sale requests another check of the current order. Its transaction hash
is optional informational metadata. Missing, malformed, orphaned or unavailable
receipts do not prevent durable admission. The validator is not required to
prove that a source's alleged transaction occurred. Canonical sync continues to
own receipt-based execution/fill decoding and activity facts separately.

Hashless OpenSea sales can still invalidate the reported seller/token scope.
A source observation for an order absent locally is retained without inventing
an order or a completed sale. A later declaration receives its own new barrier.
The source lifecycle consumer ACKs only after durable admission or an explicit
no-work decision; failed admission writes retry normally.

## Partial fills and quantities

- `original_quantity`: immutable signed NFT units when derivable.
- `quantity`: remaining units from protocol state, null until established.
- `fillable_quantity`: executable units supported by that validation snapshot.

The protocol filled fraction determines remaining inventory; its denominator
need not equal NFT units. For example, 11/20 filled of 100 leaves 45. Source
quantities cannot overwrite these fields. All canonical fills request cumulative
validation rather than assuming one event exhausted an order. Canonical
cancellation is definitive when applied by the sync writer.

Supported fixed one-NFT-item shapes derive quantities from signed terms. Buy
funding uses signed payment amounts, never untrusted source price. Partial buys
cap units by balance and allowance; full-only buys require the entire remaining
payment and expose all remaining units or zero capacity. Sell validation retains
its existing ERC721 ownership/approval scope. Unsupported shapes keep unknown
quantity rather than inventing one. Impossible fractions and uncertain reads
leave prior state intact and demand retryable.

The first block establishing a changed lifecycle result remains its attribution
in `orders.block_number`/`block_hash`. Independent `orders.proof_*` fields record
the newest successful compatible full check, order/chain revision, covered source
sequence and timestamp. Demand cleanup does not delete this evidence.

## Current-State Retention and Replay

Canonical terminal declarations remain until signed expiry: elapsed wall-clock
grace cannot prove safety while delayed canonical checks might still roll back
their result. Unknown-expiry terminal declarations remain retained until a
valid deadline is known. At expiry a rollback cannot restore executability.
Source inactivity can age out nonterminal declarations under existing retention
policy. Per-source withdrawal records survive independently until their expiry
and until the owning declaration is gone; cleanup is bounded and rechecked in
its writer. No global source-cancellation tombstone is created by the new path.

Rollback preserves signed declarations and independent source facts. It clears
orphan protocol results/quantities and admits new demand in the same transaction.
A latest proof on an orphan block is invalidated even when the unchanged result
was first established earlier. Exact retained proofs below the verified ancestor
can be rebound to the new chain revision; in-flight claims cannot. Recovery gates
positive readers until the coordinator publishes usable progress again.

## Seaport Validation

The full validator reconstructs the order hash, handles supplied ordinary/bulk
ECDSA signatures, checks validity, protocol status and maker counter, resolves
conduit/channel authority, and checks supported NFT ownership/approvals or buy
balance/allowance. Existing contract-wallet and offer-shape limitations remain.
A missing source signature does not create an immutable signature proof.

`createSeaportOrderValidationFactory` requires a coordinator checkpoint. Every
contract/native balance read uses that exact block hash. Snapshot-local sharing
includes the block identity and complete call arguments, including spender.
Conduits/channels are read within that snapshot rather than trusted from a mutable
global cache. Fresh pre/post block checks verify canonicality; there is no latest
fallback, independent head selection, or validator-written header registration.

### Bounded status aggregates

Status reads may use bounded deployless multicall with individual fallback for
provider limitations. The same checkpoint, request-budget policies and failure
boundary apply. Logical per-order reads and aggregate calls remain separately
observable. A failed aggregate or verification discards uncommitted results.

### Independent validation facts: design boundary

Runtime still performs full checks. This revamp does not introduce funding-only
validation or indefinitely cached signature/protocol/funding facts. Positive
readers require current revision, canonical membership, shared/scoped coverage,
freshness, matching order revision and coverage of pending order/maker demand.
Executable indexed quotes also require known positive remaining and funded
quantities. An unsupported shape with unknown units stays an observation; readers
must not invent one executable NFT from a null quantity.
A pending maker scope blocks only orders whose proof has not covered its exact
canonical requirement or source admission sequence; a completed early page need
not wait for the whole maker's scan. Rollback transfers pending canonical
scope requirements before rebinding surviving proofs. If a coalesced requirement
is orphaned, it conservatively requires the verified ancestor so a surviving
intermediate invalidation cannot disappear; see [rollback](06-reorg-handling.md).

### Durable maker progress

A canonical maker/token invalidation is retained before progress publication.
The indexed candidate existence check runs inside that writer; a stale fetched
bidder cache cannot drop the scope. Unknown makers with no indexed candidates
need no run. A later order still receives its own initial causal admission.

Each run captures a finite order boundary and expands bounded pages into ordinary
demand. Demand admission and cursor/continuation commit together. Scope generation,
lease, publication and replay guards survive restart. Continuations carry only
`chainId`, `runId` and `step`; the retained run owns its scope and current payload.
The transport handler enforces token versus broad routing for fresh hints and
resumes, and requires the current delivery receipt before execution. Direct
canonical admission has no broker origin.

A failed step is ACKed only after its lease is durably released to maker recovery.
Uncertain admission or release retains the delivery for retry. Periodic maker
recovery alone schedules bounded replay cleanup. Per-consumer receipts remain in
`maker_validation_delivery_origins`: main and gap consumers can both contribute
to one run, so one receipt is insufficient. New arrivals do not extend
a pass indefinitely. All current validation uses main capacity; optional history
never supplies current-state authority.

## REST Reconciliation Freshness

Initial OpenSea snapshot work starts after local collection finalization. It
retains its non-blocking bootstrap steps while the core run is already completed.
Stream subscriptions, publication and raw consumption require the current live
collection and enabled stream ingestion. Neither stream buffering during
bootstrap nor a gap-free snapshot/stream handover is required: the snapshot and
periodic live-only reconciliation provide eventual source coverage. Their
completion never gates onchain liveness or recovery.

Starting another bootstrap clears OpenSea readiness and freshness but preserves
the source identity and operator stream preference. Snapshot and reconciliation
work checks the admitted collection lifecycle and latest bootstrap run identity
inside its writer before publishing readiness, completion or retry state. Source
withdrawals use the same identity, preventing an older scan from withdrawing
replacement state. Explicit post-live metadata retries do not revoke a successful
CollectionLive handoff or block unfinished OpenSea side steps.

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

OpenSea offer criteria preserve string `traits` and numeric `numeric_traits`
(or SDK `numericTraits`) together. A numeric interval is stored as
`{ key, min, max }` in an attribute schema; exact numeric values retain the
existing `{ key, value }` shape. Bounds are finite, ordered, and inclusive.
Malformed intervals reject the whole offer rather than broaden its scope.
Numeric criteria cannot combine an exact value with interval bounds. Exact
numeric values must be decimal strings or finite numbers; containers and
conflicting value aliases reject the whole offer.
An offer with only numeric criteria is still attribute-scoped.
Stream `trait_offer` payloads supply numeric constraints in
`numeric_trait_criteria_list` with `trait_type`, `min_value`, and `max_value`
(SDK aliases use camelCase). These use the same range validation as REST
criteria, including when the string-trait fields are null or empty. Supplied
stream constraints are combined with any criteria envelope; an envelope cannot
hide them or turn a numeric-only offer into a collection offer.

The token-set registry materializes collection and attribute schemas from the
canonical local collection state:

- attribute key/value pairs are trimmed, deduplicated, and sorted before the
  normalized schema JSON is hashed with SHA-256; numeric bounds participate in
  the same fingerprint without changing existing exact-schema hashes;
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

Numeric attribute membership streams canonical metadata one token at a time
and requires every string and numeric constraint. Decimal metadata must parse
as a finite number; blank, hexadecimal, or nonnumeric text never satisfies a
range. Extension-owned attributes remain excluded.

An empty local set is `unresolved`. For an attribute offer, a computed root
that differs from the source criteria root is `mismatch`. Only a matching
resolution attaches `token_set_id` and `token_set_schema_hash` to the order.
Collection offers retain their protocol wildcard semantics independently of a
non-zero local collection-set root.

## Order Update Queues

### `orders.update-by-id`

`ApplyOrderUpdate` admits source observations on the lifecycle queue. Canonical
by-ID effects are direct sync-writer inputs and never use this source route.
Source cancellation changes availability only; source sale requests validation.

### `orders.update-by-maker`

Broad maker and token routes share finite scope expansion and continuation
recovery. Their completed scan means requirements were retained, not that every
order has already been checked. Ordinary demand owns the eventual RPC result.

## Bidder Index (Quiet Default)

Bidder discovery can include observed/unvalidated orders. It is not a positive
executability view and cannot suppress required canonical invalidation. Sync
acquires relevant bounded-range WETH events even with no realtime collections.

## Current Limits and Future Direction

The app remains local and offline-capable; no central authority is introduced.
Future peer sources must use the same observation/admission boundary. P2P
transport, funding-only fast paths, ERC1271, ERC1155 sell execution and automatic
criteria rematerialization remain outside this change. Native WETH
Deposit/Withdrawal invalidation is still deferred; periodic full validation
bounds reuse independently of event completeness.

## Historical hints and current-order validation

Historical imports enrich facts and asynchronous history projections only. They
cannot move shared/scoped applied cursors, apply current ownership, or publish
current-order invalidations. Required post-anchor catch-up uses foreground
coordinator work even when optional gap repair is disabled. Current validation
uses accepted canonical requirements and local source barriers, never queue time
or historical coverage as a substitute for readiness.
