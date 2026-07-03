# Bidding Market Snapshot Scaling

Status: investigation captured; implementation not started.

This note captures the runtime behavior, evidence, and design direction surfaced
while hardening the bidding hot path against spammed collection and trait bids.
The immediate anti-flood branch improves fairness and observability, but heavy
collections still expose a deeper market-data scaling problem.

## Current Branch Runtime Mode

The bidding bot still follows the direct OpenSea authority model:

- SQLite `trading_jobs` is the declared desired state.
- SQLite `trading_job_commands` is the durable ordered command Outbox.
- The bot owns marketplace side effects, active-order runtime state, and direct
  OpenSea reads/writes.
- OpenSea stream events are wake-up hints, not authoritative bidding data.
- The bot snapshot projection is a display/read-model sidecar, not a source for
  placement decisions.
- Canonical `orders` rows remain passive fallback display data only.

Startup now runs in this order:

1. load the unlocked wallet payload and typed config
2. load enabled bidding jobs
3. wire OpenSea stream, bidding, and snapshot lanes
4. mark restored active offers as unverified until this bot process checks them
5. bootstrap watched collection-offer snapshots
6. bootstrap token current prices
7. replay already-committed job commands while streams and snapshot polling are
   still inactive
8. subscribe direct OpenSea streams and start steady-state snapshot polling
9. start the scan loop, command loop, command listener, heartbeat, and final
   `bot_ready` signal

Command reconciliation now has these protections:

- Commands remain serial at the durable Outbox layer.
- A later command cannot leapfrog an earlier failed or retrying command.
- User command refreshes use command-priority OpenSea request context.
- Enabled-job commands can complete idempotently when the current in-memory
  runtime already verifies an active order for the same job declaration.
- Startup command replay emits lifecycle progress and heartbeat-paced progress
  while a long command is running.
- OpenSea stream subscriptions and steady-state snapshot polling do not start
  until startup command replay finishes.

Hot refresh now has these protections:

- Broad collection and trait stream events are coalesced.
- Exact item stream events are coalesced separately.
- The conservative highest-price signal wins for each queued signature.
- Queued hot-refresh work is cancelled on runtime shutdown.
- No-effect hot-refresh logs are summarized instead of emitted once per stream
  event.
- Command-driven refresh gets priority over hot-refresh work at the OpenSea
  request scheduling boundary.

The continuous scan loop currently:

- refreshes the maker WETH balance once per full scan
- processes jobs through a concurrency-limited semaphore
- keeps per-job execution serialized
- sleeps between complete full scans by `BIDDING_SCAN_SLEEP_MS`
- uses cached collection snapshots for broad competition context
- still does live exact-token reads for token jobs

## Remaining Hot-Path Risk

The branch protects the command lane from being monopolized by raw stream flood,
but it does not solve heavy full-snapshot fetches.

The current command preparation path still refreshes the full collection
all-offers snapshot for token and collection jobs before the immediate bid pass
when the snapshot is not fresh enough. That is reasonable for small collections,
but it becomes a command-lane bottleneck when a collection has thousands of
active token-scoped offers.

This is the main remaining mismatch:

- the intended runtime model is a background-maintained current market view
- the current implementation can still synchronously force a complete
  collection-wide all-offers fetch on command paths

For large collections, the command path should not start a new full
all-offers fetch for each job command. The alpha-safe direction is to keep one
collection-scoped market snapshot, make that snapshot adaptive, and let
commands use the latest usable snapshot while the background lane catches up.

## Heavy Collection Evidence

The Milady test collection produced a large active offer book dominated by
explicit item offers.

Observed runtime log evidence from the July 2, 2026 local run:

| Time | Reason | Total offers | Collection offers | Criteria offers | Explicit item offers | Observed duration |
| --- | --- | ---: | ---: | ---: | ---: | ---: |
| 20:27:20 | bootstrap | 8,544 | 72 | 271 | 8,200 | about 82 seconds from lifecycle start |
| 20:29:23 | command reconciliation | 10,277 | 74 | 271 | 9,931 | about 99 seconds |
| 20:31:35 | command reconciliation | 11,856 | 72 | 271 | 11,512 | about 115 seconds |

The projection write itself was not the bottleneck. The local SQLite
`trading_bidding_bid_book_rows` projection for the 11,856-row snapshot completed
in roughly hundreds of milliseconds. The slow stage was OpenSea pagination for
the full all-offers snapshot.

Observed row distribution in the projected Milady snapshot:

| Scope | Rows | Distinct makers | Max observed price | Average observed price |
| --- | ---: | ---: | ---: | ---: |
| token | 11,511 | 20 | about 3.45 ETH | about 1.5686 ETH |
| trait | 271 | 7 | about 1.88 ETH | about 0.0738 ETH |
| collection | 72 | 42 | about 1.04 ETH | about 0.2871 ETH |
| token_set | 1 | 1 | about 0.55 ETH | about 0.55 ETH |
| unknown | 1 | 1 | unavailable | unavailable |

The 15-token test case that surfaced the issue is only an example. The design
must handle 100+ active jobs without assuming that the active jobs represent a
small or fixed share of the collection.

## OpenSea Endpoint Probe

The current SDK surface used by the bot exposes:

- all offers: `getAllOffers(collectionSlug, limit, next)`
- collection offers: `getCollectionOffers(collectionSlug, limit, next)`
- trait offers: `getTraitOffers(collectionSlug, type, value, limit, next)`
- exact NFT offers: `getOffersByNFT(collectionSlug, identifier, limit, next)`
- best offer: `getBestOffer(collectionSlug, tokenId)`

The SDK exposes no sort or price filter parameters for the all-offers endpoint.

Observed live endpoint behavior against Milady:

- `getAllOffers` appeared globally sorted by price descending across the first
  30 pages during the probe.
- The collection floor was about 1.091799 ETH at probe time.
- The all-offers endpoint crossed that floor around pages 27 to 29.
- `getCollectionOffers` returned a small collection-wide set, roughly 70 offers,
  and was cheap compared with all-offers.
- Exact `getTraitOffers` probes were usually small.
- `getOffersByNFT` returned token-relevant item, trait, collection, and token-set
  offers in sampled responses.
- Exact NFT responses were not globally price-sorted, but sampled active tokens
  usually required one to three pages.
- `getBestOffer` remains useful as a catch-all because OpenSea endpoint
  visibility is not perfectly uniform.

These observations are useful, but they should not be treated as permanent
OpenSea API guarantees. The bot should still use pagination guards, endpoint
fallbacks, and stale-data confidence checks.

## Design Requirements

A clean scalable bidding design should preserve these requirements:

- A full scan over 100+ jobs should be mostly cache reads and predictable local CPU
  work.
- User commands should not wait behind unrelated full collection snapshot
  refreshes.
- Hot stream events should schedule or coalesce work; they should not become a
  second command queue.
- Jobs whose declared ceilings are below the current bid-wall ceiling should be
  classified as non-competitive for hot-path scheduling, so guaranteed-loser
  specs do not keep waking command-critical strategy work.
- Cache cardinality should stay collection-scoped for alpha; maintaining one
  trait or token snapshot per active target is not scalable once users bid on
  100+ tokens or multiple trait-heavy collections.
- OpenSea API usage should stay behind the existing rate limiter and priority
  policy.
- The runtime should keep direct OpenSea REST/SDK reads as the authoritative
  source for bidding decisions.
- The canonical `orders` table should remain display fallback only.
- If market data is missing or too stale to act safely, the bot should skip or
  verify rather than place a bid from unknown context.
- Bid-book projection freshness and bidder decision freshness should be modeled
  separately.
- The bid-book projection should continue to consume the bot's collection-level
  snapshot output instead of requiring a parallel data assembly path.

The earlier full collection snapshot invariant is still the right operational
shape for alpha, but its refresh cadence must reflect real collection cost. The
stronger immediate invariant is: the bot needs a usable collection-level market
view without making every command wait for a newly fetched all-offers snapshot.

## Rejected Slice Model

Per-target market slices are not the preferred alpha design.

Rejected slices:

- token-offer slices from `getOffersByNFT` for every active exact-token job
- trait-offer slices from `getTraitOffers` for every active trait bucket
- competitive-trait slices for every expanded competitor bucket

Reason:

- users will reasonably bid on 100+ tokens
- two or more active collections can quickly produce hundreds of trait buckets
- per-target refresh state would compete with the command lane and the scan loop
- the bid-book projection already depends on a collection-level market view
- one local bot process should not become a general-purpose per-target OpenSea
  cache warmer

Endpoint-specific reads still have a place for placement, cancellation, active
own-order recovery, and fallback verification. They should not become the main
background freshness model for alpha.

## Adaptive Complete Snapshot Model

Keep one collection-level offer snapshot per watched collection, but make it
adaptive to real fetch cost.

The snapshot should still cover all fetched offer kinds in one collection pass:

- collection-wide offers
- trait/criteria offers
- exact-token offers
- token-set or unknown offers that the parser can classify or preserve safely

The snapshot record should own:

- last successful refresh time
- last started time
- last refresh duration
- offer count and page count
- lowest fetched price and highest fetched price
- last error
- next eligible refresh time

Normal scans should:

- read the latest usable collection snapshot from memory
- avoid per-job all-offers refreshes
- schedule refresh when the snapshot is stale by its adaptive collection cadence
- keep the existing single-job evaluation behavior intact in this pass,
  including narrow OpenSea reads used for own-order recovery, cancellation
  safety, and fallback verification

User commands should:

- add or update the in-memory job immediately
- reuse the latest usable collection snapshot when present
- request an urgent background collection refresh when the snapshot is stale
- complete idempotently when current runtime evidence satisfies the desired job
  declaration
- avoid forcing a fresh all-offers fetch per command unless no usable collection
  snapshot exists and the job cannot be evaluated safely

Hot refresh should:

- coalesce by collection and event signature
- keep the highest-price signal per signature
- wake the affected jobs only when the event can change a competitive decision
- request a collection refresh when a relevant event invalidates the current
  collection-level market view
- ignore or summarize guaranteed-irrelevant hot-refresh flood for jobs that are
  non-competitive by their declared ceiling

Bid-book projection should:

- keep projecting from the bot's collection-level snapshot while the bot is live
- project all rows present in the complete snapshot
- expose source/freshness metadata clearly enough for the backend to choose
  between competitive bot projection and normal orders fallback
- not block bidder command or hot paths

## Dynamic Freshness Policy

Static freshness settings are too brittle across collections.

The next design should make refresh cadence adaptive per collection:

- base interval comes from app config
- minimum interval remains positive; disabling by zero should not be supported
- next refresh uses recent duration and error history
- expensive collections get longer intervals automatically
- failed snapshots back off without blocking unrelated command work
- command-triggered refresh requests can ask for urgency, but still respect the
  shared OpenSea rate limiter and collection-level dedupe

A practical first formula can be:

- next interval is at least the configured base interval
- next interval is at least a small multiple of the last successful duration;
  the alpha default can start at two times the last duration
- interval is capped by a configured maximum
- failures use exponential backoff with jitter

For example, a collection whose complete snapshot takes 80 seconds should not
try to refresh every 15 seconds. It should slow down automatically while still
keeping a clear stale/freshness state for the bot and UI.

Full all-offers snapshots should log duration, page count, offer count, price
range, and scope distribution.

## Race And Resource Exhaustion Findings

Problems already addressed on this branch:

- hot-refresh work could outlive runtime shutdown
- latest queued event could drop the higher-price conservative signal
- stream subscriptions could start during startup command replay
- item hot events were not coalesced like broad events
- user-command OpenSea work could sit behind hot-refresh work
- no-effect hot-refresh logs could emit at high rate during spam
- startup command replay had silent gaps that looked like a stalled process
- source-level collection snapshot telemetry records page count, duration,
  offer count, first/last price, min/max price, and final cursor state
- collection snapshot freshness is adaptive from app config, using the last
  successful fetch duration with a configured maximum TTL
- failed TTL-aware snapshot refreshes back off with jitter instead of retrying
  blindly on every poll or hot signal
- command preparation reuses an existing collection snapshot and only blocks for
  the first missing snapshot needed to safely evaluate token/collection jobs
- hot refresh ignores token jobs whose effective ceiling cannot beat the broad
  market event price

Problems still not fully addressed:

- full scans still mix collection-snapshot reads with narrow per-token live
  reads, but single-job processing is acceptable today and should not be
  aggressively changed in this alpha scaling pass
- competitive trait jobs can fan out into many trait endpoint reads and need
  explicit fan-out limits
- pending hot-refresh signatures are still limited only by natural collection
  and target diversity, not by an explicit hard cap

## Implementation Direction

Implemented alpha-scaling steps:

1. Add source-level snapshot telemetry: page count, duration, first/last price,
   min/max price, offer count, and final cursor state.
2. Add adaptive per-collection snapshot freshness from app config, using recent
   refresh duration as an input.
3. Stop command preparation from forcing a fresh full snapshot per token or
   collection command when a usable collection snapshot already exists.
4. Keep normal single-job processing behavior unchanged while reducing only
   shared collection-snapshot and hot-path scheduling pressure.
5. Keep bid-book projection on the same collection snapshot output, including
   completeness metadata.
6. Classify guaranteed-loser jobs below the current bid-wall ceiling so hot
   refresh does not keep exercising strategy for jobs that cannot win by spec.
7. Add focused tests around adaptive TTL, failed refresh backoff, source
   telemetry, and non-competitive hot-refresh filtering.

The target architecture is still a background-maintained current-world market
view. For alpha, the change is making that world view adaptive while keeping
cache ownership collection-scoped.

## DEFERRED UNTIL FURTHER NOTICE

Snapshot depth cutoff is deferred. Local bid-book visualization suggests that
cutting at the collection-wide bid ceiling would save roughly 20% of requests on
the observed heavy collection. That may be useful later, but it is not the next
alpha-scaling step.

Deferred cutoff-related ideas:

- stop all-offers pagination only after the page stream crosses a
  strategy-derived collection cutoff
- derive that cutoff from current collection/trait bid-wall evidence plus active
  job ceilings
- keep enough depth for "keep winning" decisions and near-ceiling opponent
  movement
- avoid chasing the flooded low-price tail when every relevant active job would
  still be a loser by its own declared ceiling
- track cutoff price and bounded/degraded fetch state in snapshot metadata
- use the observed price-descending all-offers ordering conservatively, with
  pagination-loop and ordering guards
