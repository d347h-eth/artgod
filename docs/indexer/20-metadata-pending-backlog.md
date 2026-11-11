# Permanent Pending Metadata

Domain-worker owns the durable metadata obligation and its background executor.
A token whose URI, HTTP payload or extension-defined content is unavailable
stays pending in SQLite until a later attempt succeeds or the token/collection
is removed. There is no retry-count or age deadline. Pending tokens do not
become delayed NATS messages.

## Decision and alternatives

Centralized metadata can return HTTP 200 before the useful content is ready.
Increasing ordinary HTTP retries does not address this outcome. Readiness is a
domain result; it is separate from HTTP success, broker ACK and bootstrap
completion.

| Option                                                | Benefit                                                                  | Limitation                                                                                                                                         |
| ----------------------------------------------------- | ------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| Retain a delayed broker delivery per token            | Existing durable transport and redelivery                                | Delivery counts, due scheduling and indefinite content readiness become coupled; per-token progress is harder to inspect or suspend independently. |
| SQLite schedule that publishes due retry jobs         | SQLite owns the obligation; workers can be separated                     | Requires a second publication/recovery boundary and delivery fencing despite execution already belonging to domain-worker.                         |
| SQLite obligations consumed directly by domain-worker | One durable state owner, coalesced requests and bounded direct execution | Requires explicit leases, stale-result fences, pacing and lifecycle checks.                                                                        |

The third option follows the existing database-backed validation-demand and
automatic-sync executors. NATS is file-backed durable transport, so the first
option is not inherently unsafe. SQLite is selected because indefinite content
readiness needs its own lifecycle and queryable progress. NATS still carries
normal initial notifications and retained successful-write follow-ups.

## Ownership

- `MetadataDomain` is the application use case shared by bootstrap, transfer
  sync, explicit refreshes and background retries.
- `MetadataStorePort` requires atomic persistence of canonical metadata and
  retry progress. `SqliteMetadataStore` implements that contract.
- `CollectionExtensionMetadataReadiness` delegates successful-response
  assessment to an enabled extension's optional `isMetadataReady` hook.
  Ordinary parsed metadata is ready when no hook applies.
- Domain-worker's pending poller invokes the same use case directly. Scheduler
  retains chain-head scheduling; collection-extension-worker retains artifact
  work. No runtime or retry queue is added.

The core contains no collection-specific field names, placeholder URLs or
deployment identities.

## Retained state and transaction boundaries

Migration `074_metadata_pending.sql` adds one `metadata_pending` row per
`chain_id + collection_id + token_id`. It retains media-selection options,
first-pending/last-attempt times, attempt count, reason, next availability and
an optional lease owner. It does not retain an extra metadata document or an
unbounded attempt-history table.

An initial request records intent before network I/O. The row also fences
overlapping requests. A unique attempt owner changes on every admission or
claim; an older response cannot complete after a newer request or after a row
was deleted and recreated. This adds a short admission transaction before the
existing canonical write; no database transaction spans RPC or HTTP work.

`due_at` means the next availability time. An unleased row uses its retry time;
a leased row uses its lease expiry. A two-minute lease is renewed every thirty
seconds. On crash, an expired row becomes eligible again without a startup
rescan or a broker publication.

Migration `075_metadata_pending_failures.sql` separates admission attempts from
hosting failures. Only unavailable URI/fetch and incomplete-response outcomes
advance `failures`, which controls backoff. RPC-allocation, ownership and
pause/disable deferrals do not advance it, including superseded requests.
Resuming allocation therefore does not inherit a long server backoff solely
from time spent paused.

Successful complete metadata replaces canonical metadata and clears the row.
An incomplete response can initialize a token's first metadata, but never
overwrites an existing observation. The obligation remains pending. URI/fetch
failures likewise retain intent; original bootstrap best-effort settlement
continues independently, so hosting delays do not impose an unbounded bootstrap
gate.

For background writes, canonical persistence, pending progress and required
extension/stat/image-cache outbox effects share one transaction. If retaining
effects fails, the canonical write rolls back and the obligation remains.
Existing initial transport/bootstrap batching keeps its normal follow-up path.
Image caching continues to follow the collection's configured policy; metadata
readiness does not independently prove that remote media bytes are available.

Retries resolve the canonical URI again using current collection identity and
current ownership evidence. They do not retain an old OpenSea URL or historical
bootstrap RPC block pin. Requested image/animation source fields are retained,
including an explicit disabled animation selection.

## Pace, fairness and lifecycle

Policy constants belong to `indexer/src/domain/metadata-pending.ts`:

- two independent lanes, each waiting one second after every completed pass;
  at most two new attempts per second, and at most two concurrent background
  requests, per domain-worker process;
- existing background (`gap_repair`) RPC allocation applies, keeping this work
  separate from normal foreground metadata requests;
- exponential retry ceilings start at fifteen seconds and cap at one hour,
  with deterministic per-token jitter between 75% and 100% of that ceiling;
- no terminal attempt limit, expiry or automatic abandonment due to host age.

These limits govern availability and resource use, not a freshness guarantee.
A large overdue backlog can take longer than the backoff ceiling to drain.
Normal first attempts retain their existing immediate path. The poller does
not create a timer or promise per pending token, nor load the whole backlog.

Live collections rotate in collection-ID order, including passes that clean
obsolete work. Within a collection, selection uses the indexed due time and
token ID. A pass reconciles at most sixteen ownerless rows, removing confirmed
ERC721 burns and deferring other ownership waits. Due lookup
uses `(chain_id, collection_id, due_at, token_id)`; inactive collections are
excluded before reading their pending rows. Transfer candidate discovery uses
bounded keyset pages, closing each reader before network work and writes.

Paused and disabled collections retain obligations without background fetches.
Bootstrap obligations become eligible when their collection becomes live and
ownership is materialized. Missing materialized ownership alone does not erase
known intent: those rows wait for ownership, without RPC, and become eligible
again after fifteen seconds. An ERC1155 transfer/balance subset is not treated
as proof that its token ID is extinct. Confirmed ERC721 burns are checked again
before completion. A captured chain revision rejects
responses spanning rollback; later passes read current ownership again.
Collection identity, active status, lease owner and expiry are rechecked in the
write transaction. Purge explicitly deletes pending rows, with a cascading
foreign key as an additional guard; late responses cannot recreate them.

Shutdown stops new passes, interrupts idle waits and awaits in-flight work.
Existing RPC/HTTP timeout and budget shutdown contracts continue to apply.

## 111K readiness

The `111k` extension requires a nonempty string-valued `collection block` trait
and a non-placeholder image. If the response explicitly supplies `revealStatus`,
it must be `revealed`. An absent root remains pending even when that flag says
revealed. The extension owns those names and URL semantics.

Some previously captured host responses declared revealed while lacking the
required root. This policy deliberately keeps them pending. Retries cannot
invent the field or guarantee the host will eventually supply it. Trait
hierarchy/restructuring, manual Userland controls and another trait report are
outside this change.

## Operations and verification

The existing runtime metrics exporter exposes `metadata.pending.attempts`,
`metadata.pending.backlog` and `metadata.pending.oldest_age_ms`, under its usual
indexer prefix/normalization. Attempts count background attempts, not readiness
successes. Backlog/age include paused obligations and are sampled every thirty
seconds. `MetadataPending` logs response readiness and whether a canonical
write applied; a successful HTTP counter alone does not establish readiness.

Every extension readiness rejection also emits an `info` log with message
`Metadata response not ready` and component `MetadataPending`. It includes
`metadataUrl`, `extensionKey`, `chainId`, `collectionId`, `contract` and
`tokenId`, including repeated rejections of the same token. This applies to
bootstrap, ordinary refresh and pending-retry lookups. The URL comes from the
fetched metadata in memory, so it remains available in logs when raw/URI debug
persistence is disabled. Ready responses do not emit this rejection log.

Pending rows expose `attempts`, `failures`, `reason`, `first_pending_at`, `last_attempt_at`,
`due_at` and `lease_owner`. Times are epoch milliseconds. There is no new manual
refresh API or retry-administration UI. Existing rows are enrolled when the
normal metadata path attempts them; migration does not silently rescrape
already stored collections. A fresh bootstrap enrolls its first attempts.

Coverage includes HTTP-success/pending-to-ready transitions, generic URI/fetch
failures, repeated pending results beyond ordinary queue limits, coalescing,
lease recovery, stale requests, pause/disable, purge/burn/rollback during I/O,
retained media options, transactional follow-up failure, pacing/shutdown and
indexed/fair selection. See `indexer/tests/metadata-pending.test.ts` and
`indexer/tests/metadata-pending-poller.test.ts`.

Local adapter/use-case tests do not qualify a rebuilt installed desktop or a
new live collection bootstrap. The running instance is not mutated by tests.
