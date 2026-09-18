# Bidding Market Data and Scaling

The bidding bot needs a current market view without turning every active job or
stream event into a fresh collection-wide OpenSea crawl. The current design
keeps one authoritative in-memory offer snapshot per snapshot-backed collection
(a collection with an enabled token or collection job) and separates that
decision input from display projections.

## Authority Model

- SQLite `trading_jobs` is declared strategy intent.
- SQLite `trading_job_commands` is the durable ordered command outbox.
- Direct OpenSea REST/SDK reads are authoritative for bidding decisions.
- OpenSea stream events are wake-up hints; they are not complete market state.
- The bot collection snapshot is the broad competition view used by bidder
  decisions.
- Narrow exact-token and trait endpoints remain available for placement,
  cancellation, active-own-order recovery, and fail-closed verification.
- `trading_bidding_bid_book_*` is a display projection of bot state.
- Canonical indexer `orders` is a passive display fallback only. It never feeds
  placement or competitiveness.

Here, authoritative identifies the decision input chosen by the runtime, not a
guarantee that the provider's data is immediately current. Snapshot freshness
is bounded by policy. Only a complete pagination traversal may replace the
authoritative snapshot; repeated-cursor results are rejected as described below.

The [bidding lifecycle diagram](../diagrams/10-bidding-command-and-offer-lifecycle.md)
shows where declared state, authoritative market reads, side effects, and
display state meet.

## Collection Snapshot Traversal

`OpenSeaCollectionOfferSource` walks `getAllOffers(collectionSlug, limit, next)`
until the cursor ends or a cursor repeats. It retains all returned offer kinds
that later parsing can classify or preserve: collection, trait/criteria, exact
token, token set, and unknown.

Completed fetches record metrics, and the snapshot service logs a summary:

- duration, page count, offer count, and final cursor;
- first, last, minimum, and maximum parseable prices;
- a scope distribution summary and observed trait types.

When a cursor repeats, the adapter logs a pagination-loop error, stops the walk,
and marks the result incomplete. The snapshot service rejects that refresh,
records a partial result, retains the previous complete snapshot (if any), and
enters failure backoff. An exhausted page request similarly preserves the last
complete snapshot and records an error. Neither result is published as fresh
market data or sent to the bid-book projection. A first refresh without a
previous complete snapshot remains unavailable. The adapter uses the dedicated
snapshot OpenSea request limiter and bounded retry policy.

The snapshot service serializes refresh work per collection. Concurrent callers
join or coalesce around the same work rather than starting parallel full crawls.
Its observer requests the bid-book projection asynchronously; a projection
failure does not make the authoritative snapshot or bidder action fail.

## Adaptive Freshness and Failure Backoff

Three typed settings control successful snapshot freshness:

- `BIDDING_COLLECTION_OFFERS_TTL_MS` — minimum freshness window, default 15
  seconds;
- `BIDDING_COLLECTION_OFFERS_MAX_TTL_MS` — maximum adaptive window, default 5
  minutes;
- `BIDDING_COLLECTION_OFFERS_ADAPTIVE_TTL_MULTIPLIER` — last-fetch-duration
  multiplier, default 2.

For one successful snapshot:

```text
freshness = min(max TTL, max(base TTL, ceil(fetch duration * multiplier)))
```

An 80-second fetch therefore receives a 160-second freshness window with the
current defaults instead of being immediately scheduled again by a 15-second
base TTL.

TTL-aware failures back off from the base TTL with an exponential factor of two,
20% positive jitter, and the same maximum-TTL cap. A success resets failure
state. A forced refresh can bypass TTL/backoff eligibility when recovery must
wait for current data, but it still respects per-collection serialization and
the dedicated snapshot OpenSea request limiter.

`BIDDING_COLLECTION_OFFERS_POLL_MS` controls how often the background lane asks
snapshot-backed collections whether a refresh is due; it does not force every
poll to hit OpenSea.

## Startup and Command Behavior

Startup builds one snapshot for every collection with an enabled token or
collection job before steady-state placement begins. Competitive-trait-only
collections are watched for stream events but are not part of this broad
snapshot lane. The runtime then replays committed commands while stream
listeners and periodic snapshot polling are still inactive. This avoids hot
events racing with recovery of declared intent.

For a later command:

- the runtime applies the new declaration in memory;
- if a usable collection snapshot exists, the command reuses it and requests a
  background refresh when stale;
- if no snapshot exists and the job cannot be evaluated safely, the command
  waits for the first collection snapshot;
- if the current process has already verified the exact desired active offer,
  reconciliation may complete idempotently without another OpenSea pass.

Commands are serialized by the durable outbox and receive command-priority
OpenSea scheduling. An earlier retrying command cannot be leapfrogged by a later
one.

## Stream and Hot-Refresh Pressure

Broad collection/trait events and exact-item events have separate cooldown and
pending-signature budgets. Within a signature, the highest observed price wins
so coalescing remains conservative. When a pending budget is full, the
backpressure component drops the incoming signal when it is not stronger than
the weakest queued signal; otherwise it evicts that weakest signal. Each drop
or eviction is logged with queue counts.

The runtime also:

- cancels queued hot work during shutdown;
- waits until command replay completes before subscribing streams;
- lets user commands outrank background hot refresh at OpenSea adapter
  bottlenecks;
- skips token-job hot refresh when the event price meets or exceeds that job's
  effective ceiling;
- fails closed when a competitive-trait target expands beyond
  `BIDDING_COMPETITIVE_TRAIT_MAX_LOOKUP_SELECTORS` (default 64).

Token and collection full scans read the broad snapshot; token jobs may still
perform narrow live token reads. Competitive-trait scans bypass the snapshot
and use live collection and trait pagination after a configured selector-count
guard. Per-job execution remains serialized, and configured job concurrency is
deliberately conservative.

## Bid-Book Display Selection

After a successful snapshot, the projection sidecar writes parsed offer rows and
snapshot metadata to SQLite. Backend reads use that source only when all of
these are true:

- the collection has enabled bidding jobs;
- the bot lifecycle resolves to active from a fresh running heartbeat within
  `BIDDING_RUNTIME_HEARTBEAT_STALE_MS`;
- the projected snapshot is within `BIDDING_BID_BOOK_SNAPSHOT_STALE_MS`.

Otherwise the backend falls back to canonical indexer orders. The UI labels the
source and refreshes more frequently while a live bot projection is selected.
Bidder decision freshness and display-projection freshness are intentionally
separate.

When own-job context is requested, the backend loads the latest persisted
bidding-bot wallet address for the chain and marks matching rows from either
display source as the user's offers. This passive maker identity is separate
from collection authorization. Own-maker feedback is therefore available on
the indexed-orders fallback; it is not dependent on a live bot projection.

## Why Full Snapshots Are Expensive

The adapter requests every cursor page and retains every returned offer in
memory. Fetch work, memory use, parsing, and projection size therefore grow with
the current depth of the collection offer book. Adaptive freshness, command
snapshot reuse, coalescing, and pending-work caps bound how often that work is
repeated; they do not bound one traversal.

`scripts/debug/milady-offer-depth.mjs` can record a live diagnostic crawl, but
its results depend on current OpenSea data and credentials. The repository does
not contain a checked-in measurement that establishes stable fetch time,
projection time, scope distribution, or price ordering.

## Current Limits and Future Direction

- The first missing broad snapshot can still block a command that cannot act
  safely without broad competition context.
- Repeated cursors and failed traversals leave the previous complete snapshot
  aging under its normal freshness policy, or leave market data missing until a
  complete refresh succeeds. The runtime does not treat partial data as fresh.
- Full `getAllOffers` pagination can remain expensive on deep offer books.
- A hard price/depth cutoff is deliberately deferred. A future bounded snapshot
  must derive a conservative strategy cutoff, record degraded/bounded state,
  validate any ordering assumption, retain enough depth for winning decisions,
  and fall back to a full fetch when confidence is lost.
- Maintaining one target-specific background snapshot per token or trait is not
  the preferred direction: 100+ jobs would turn the bot into an unbounded cache
  warmer. Exact endpoints remain narrow verification tools.
- Deep display pagination should move to SQL keyset reads if bounded in-memory
  offer-card grouping becomes a measured backend bottleneck.

### Retained SQL Pagination Boundary

The future page remains grouped by token, not by offer row. Trait filters and
the low-signal mute floor must run before pagination, group counts must exclude
hidden offers, and full token-card data should load only for the page's token
ids.

Source authority does not change:

- use the selected live and fresh bot projection when its existing policy
  allows it;
- otherwise read normalized canonical `orders`;
- never turn the passive display repository into the bidder's decision
  authority;
- never reparse raw marketplace JSON for the page.

The application use case continues to resolve collection references, facets,
customization, source selection, and response mapping. A repository adapter owns
source-specific SQL, trait filtering, grouping, cursor encoding, and loading the
page rows from `orders` or `trading_bidding_bid_book_rows`.

Wei amounts are normalized decimal strings and can exceed SQLite's integer
range. Ranking must compare string length before lexicographic value, then use a
deterministic token/order tie-breaker; it must not use an integer cast. Rank the
top offer within each token group before building a keyset cursor from its price
length, price text, and token id. Candidate partial indexes should be added only
after the final query shape and query-plan evidence justify them.

Focused verification must cover trait-filter-before-pagination, muted-offer
counts, stable forward cursors, equal-price ties, very large wei values,
bot-projection/indexed-orders source parity, and loading token cards only for
the selected page.

Automated adapter tests cover normalized SDK shapes and failure handling, but a
dependency or endpoint migration still requires a live credentialed OpenSea
check for production pagination, rate limits, stream delivery, and response
ordering. Any ordering observed during a diagnostic run is evidence for that
run only, never an API contract.

These retained outcomes are `BKL-049` and `BKL-051` in the
[unified backlog](../planning/01-unified-backlog.md).

## Verification

Focused ownership lives in:

- `trading/src/application/use-cases/bidding/collection-offer-snapshot-service.test.ts`;
- `trading/src/adapters/opensea/open-sea-collection-offer-source.test.ts`;
- `trading/src/application/use-cases/market/pipeline/lib/hot-refresh-backpressure.test.ts`;
- `trading/src/application/use-cases/bidding/bidding-bid-book-projection.test.ts`;
- backend bid-book repository/use-case tests.

Run the complete owner suite with:

```sh
yarn workspace @artgod/trading test
```
