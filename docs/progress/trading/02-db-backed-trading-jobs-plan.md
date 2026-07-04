# DB-Backed Trading Jobs Plan

Status: Implemented for bidding; sniping reuse deferred
Current milestone: DB job management, runtime reconciliation, and bid-book display are active

This document is the working plan for moving bidding jobs, and later sniping jobs, from operator-managed JSON files into ArtGod SQLite.

The near-term implementation is bidding-first. Sniping should reuse the same job lifecycle and command model later, but should not block the first bidding pass.
The current-state reference for the implemented bidding runtime is `docs/trading/01-bidding-runtime-and-jobs.md`.

## Goals

- Persist trading job desired state in SQLite instead of JSON files.
- Keep the battle-tested bidding runtime behavior intact.
- Keep the bidder's direct OpenSea stream, REST, SDK, and snapshot lanes as the authoritative market-operation path.
- Add backend CRUD and Userland UI management for bidding jobs.
- Allow dynamic job changes without bot restart in the long-term runtime model.
- Close the backend crash window between DB commit and bot wake-up signal publication.
- Treat job disable/delete as market-side lifecycle actions that eventually cancel active offers.
- Build the schema and API in a way that can support sniping jobs later.

## Non-Goals

- Do not make ArtGod's canonical `orders` table the bidder's source of truth.
- Do not rewrite bidding business logic while adding persistence.
- Do not build collection-scoped or trait-scoped job creation UI in the first UI pass.
- Do not build sniping-specific persistence or runtime behavior until bidding is stable.

## Hard Invariants

1. DB persistence stores declared desired job state. It must not replace the bidder's OpenSea-backed competitiveness model.
2. The bidding runtime still owns market-side effects: bid placement, cancellation, allowance checks, and OpenSea reads.
3. Backend CRUD must not call OpenSea directly and must not reach into bot internals.
4. Job changes must be durable in SQLite before any runtime signal is emitted.
5. Backend must write desired job state changes and Outbox rows in the same SQLite transaction.
6. JetStream is the low-latency wake-up path after publish. The Outbox exists specifically to close the DB-commit-to-publish gap.
7. The bot must process Outbox rows both on immediate wake-up and on periodic recovery scans.
8. Human-readable config, API, and UI values should use Ether units. Runtime internals and DB amount columns can use wei strings.
9. Delete/disable semantics must be deliberate. If a job has an active offer, the bot stops scheduling it and requests offer cancellation.
10. Runtime reconciliation must be dynamic; bot restart is not required for normal bidding job CRUD.

## Domain Model

The central distinction is:

- declared job: the user's desired trading configuration
- runtime state: what the bot last observed or did for that job
- command/outbox item: a durable side-effect request that the bot must process

This prevents CRUD from being confused with market execution.

Signal model:

- DB is authoritative desired state.
- Outbox is authoritative downstream effect state.
- JetStream is the speed-up signal only.

## Implemented Schema

### `trading_jobs`

Common envelope for bidding and future sniping jobs.

```sql
CREATE TABLE trading_jobs (
  job_id TEXT PRIMARY KEY,
  bot_kind TEXT NOT NULL,
  chain_id INTEGER NOT NULL,
  collection_id INTEGER NOT NULL,
  status TEXT NOT NULL,
  target_kind TEXT NOT NULL,
  token_id TEXT,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT DEFAULT CURRENT_TIMESTAMP,
  archived_at TEXT,
  revision INTEGER NOT NULL DEFAULT 1,
  FOREIGN KEY(collection_id) REFERENCES collections(collection_id),
  CHECK (bot_kind IN ('bidding', 'sniping')),
  CHECK (status IN ('enabled', 'paused', 'archived')),
  CHECK (target_kind IN ('token', 'collection', 'competitive_trait')),
  CHECK (
    (target_kind = 'token' AND token_id IS NOT NULL)
    OR (target_kind != 'token' AND token_id IS NULL)
  )
);
```

Indexing:

```sql
CREATE INDEX trading_jobs_collection_idx
  ON trading_jobs (chain_id, collection_id, bot_kind, status, updated_at);

CREATE UNIQUE INDEX trading_jobs_token_target_uq
  ON trading_jobs (chain_id, collection_id, bot_kind, target_kind, token_id)
  WHERE target_kind = 'token' AND status != 'archived';
```

First-pass status semantics:

- `enabled`: loaded and scheduled by the bot.
- `paused`: not scheduled; long-term runtime should cancel any active offer.
- `archived`: hidden by default; long-term runtime should cancel any active offer and then stop caring except for audit.

### `trading_bidding_job_specs`

Bidding-specific declared strategy fields.

```sql
CREATE TABLE trading_bidding_job_specs (
  job_id TEXT PRIMARY KEY,
  floor_wei TEXT NOT NULL,
  ceiling_wei TEXT NOT NULL,
  delta_wei TEXT NOT NULL,
  quantity INTEGER,
  target_traits_json TEXT,
  competitor_traits_json TEXT,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY(job_id) REFERENCES trading_jobs(job_id)
);
```

Field meanings:

- `floor_wei`: minimum bid unit price in wei.
- `ceiling_wei`: maximum bid unit price in wei.
- `delta_wei`: bid increment in wei.
- `quantity`: used by collection and competitive-trait jobs; `NULL` for token jobs.
- `target_traits_json`: exact target trait constraints. For collection criteria offers this is the collection offer trait set. For competitive-trait jobs this contains the target trait as an array.
- `competitor_traits_json`: only used by competitive-trait jobs.

First-pass token jobs should use:

- `target_kind = 'token'`
- `token_id = '<token id>'`
- `quantity = NULL`
- `target_traits_json = NULL`
- `competitor_traits_json = NULL`

### `trading_bidding_job_runtime_state`

Bot-owned runtime state. This is not the source of desired configuration.

```sql
CREATE TABLE trading_bidding_job_runtime_state (
  job_id TEXT PRIMARY KEY,
  current_price_wei TEXT,
  active_order_id TEXT,
  active_protocol_address TEXT,
  active_expiration_time_ms INTEGER,
  last_run_at TEXT,
  last_error TEXT,
  cancellation_requested_at TEXT,
  cancellation_completed_at TEXT,
  cancellation_error TEXT,
  updated_at TEXT DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY(job_id) REFERENCES trading_jobs(job_id)
);
```

Runtime state can start as optional or unused. The clean long-term delete/disable path benefits from persisting active order identity so a restarted bot can still cancel stale offers.

### `trading_job_commands`

Durable Outbox for runtime side effects.

```sql
CREATE TABLE trading_job_commands (
  command_id INTEGER PRIMARY KEY AUTOINCREMENT,
  job_id TEXT NOT NULL,
  bot_kind TEXT NOT NULL,
  command_kind TEXT NOT NULL,
  status TEXT NOT NULL,
  requested_revision INTEGER NOT NULL,
  payload_json TEXT NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP,
  claimed_at TEXT,
  completed_at TEXT,
  FOREIGN KEY(job_id) REFERENCES trading_jobs(job_id),
  CHECK (bot_kind IN ('bidding', 'sniping')),
  CHECK (command_kind IN ('job_created', 'job_updated', 'job_paused', 'job_archived', 'cancel_active_offer')),
  CHECK (status IN ('pending', 'processing', 'completed', 'failed_retry', 'failed_terminal'))
);
```

The command table is the recovery mechanism. NATS can notify the bot immediately, but the DB command is what guarantees the bot can recover missed changes.

This is the table that closes the backend crash window between:

1. committed DB job change
2. published JetStream wake-up event

Backend writes the job mutation and the Outbox row in one SQLite transaction. After commit, backend best-effort publishes a JetStream event. The bot uses the event for immediate processing and also scans pending Outbox rows periodically for recovery.

### `trading_bidding_bid_book_rows`

Materialized display rows for the bid book.

The bidding runtime writes `bot_snapshot` rows from its OpenSea collection-offer snapshots. Backend fallback reads synthesize `orders` rows from canonical orders using the shared OpenSea bidding-offer parser.

Important fields:

- `source`: `bot_snapshot` or `orders`
- `scope_kind`: `collection`, `trait`, `token`, `token_set`, or `unknown`
- `scope_traits_json`: full trait criteria for trait-scoped bids
- `encoded_token_ids`: token-set payload when available
- `price_wei`: unit price in wei
- `quantity`: offer quantity as a string
- `placed_at`: source order creation time when available
- `valid_until`: source expiration timestamp in seconds

### `trading_bidding_collection_bid_book_state`

Projection freshness and diagnostics per collection/source.

The bot updates this after snapshot projection replacement. Backend reads it to expose row counts, projection time, duration, and last error to the UI.

### `trading_bot_runtime_state`

Non-secret bot heartbeat table.

Backend uses this table with projection freshness metadata to decide whether `bot_snapshot` is a live bid-book source. If a collection has enabled jobs but the heartbeat or projection is stale, backend falls back to `orders` for read-only display.

## Backend API Shape

Trading routes are local backend routes. Mutating job routes are protected by the existing host/origin/CSRF guards.

Collection bidding page:

- `GET /api/:chain_ref/:collection_ref/bidding/bids`
- Lists collection bid-book rows.
- Missing `bid_scope` defaults to `token`, which returns explicit token-scoped offers grouped as paginated token cards in `tokenOfferCards`.
- Query `bid_scope=token` applies normal token trait filtering and returns all non-muted explicit token-scoped offers for each matching token card.
- Token-scoped offers and trait-scoped bid rows below 10% of the current top collection-wide bid are hidden; token-card offer counts exclude hidden token offers.
- Query `bid_scope=collection` returns collection-wide bids only.
- Query `bid_scope=traits` returns trait-scoped bids and applies repeated `traits=key:value` / `trait_ranges=key:from..to` filters.
- Trait bid-book filtering defaults to `trait_join=or`, where any selected trait key-value or range can match a bid criterion.
- `trait_join=and` keeps strict matching where the bid's full trait criterion set must exactly match the selected filters.
- Source selection prefers the bot snapshot projection only when enabled jobs exist, the bidding bot heartbeat is live, and projection metadata is fresh; otherwise it falls back to orders.

Token detail management:

- `GET /api/:chain_ref/:collection_ref/:token_ref/bidding/job`
- `PUT /api/:chain_ref/:collection_ref/:token_ref/bidding/job`
- `DELETE /api/:chain_ref/:collection_ref/:token_ref/bidding/job`
- `GET /api/:chain_ref/:collection_ref/:token_ref/bidding/bids`
- Token bid-book rows include all applicable scopes: collection, trait, token-set, and exact-token.

First-pass token job body:

```json
{
  "status": "enabled",
  "floorEth": "0.10",
  "ceilingEth": "0.20",
  "deltaEth": "0.001"
}
```

Response values should use both stable IDs and human-readable Ether strings where useful:

```json
{
  "job": {
    "jobId": "bidding:1:123:token:456",
    "status": "enabled",
    "target": {
      "type": "token",
      "tokenId": "456"
    },
    "config": {
      "floorEth": "0.10",
      "ceilingEth": "0.20",
      "deltaEth": "0.001"
    },
    "runtime": {
      "activeOrderId": null,
      "currentPriceEth": null,
      "lastRunAt": null,
      "lastError": null
    }
  }
}
```

## Backend Use Cases

Follow the backend hexagonal rules:

- use cases under `backend/src/application/use-cases/trading/*`
- outbound ports local to each use-case module unless reuse becomes real
- SQLite adapter under `backend/src/infra/trading/*`
- HTTP adapters under `backend/src/http/handlers/trading/*`
- composition in `backend/src/index.ts`
- route registration in `backend/src/http-routes.ts`

Initial per-target use cases:

- `GetTokenBiddingJobUseCase`
- `UpsertTokenBiddingJobUseCase`
- `ArchiveTokenBiddingJobUseCase`
- `ListCollectionBiddingBidBookUseCase`
- `GetTokenBiddingBidBookUseCase`

Expanded bidding automation use cases:

- `UpsertTraitBiddingJobUseCase`
- `UpsertCollectionBiddingJobUseCase`
- `UpsertBatchTokenBiddingJobsUseCase`
- `ArchiveBiddingJobUseCase`
- price tier list/upsert/archive/reapply use cases
- collection bidding settings use case

Validation rules:

- Resolve `chain_ref` through the existing chain resolver.
- Resolve `collection_ref` through the existing collection read port.
- Token job operations require the token to belong to the resolved collection.
- `floorEth`, `ceilingEth`, and `deltaEth` must parse as positive Ether amounts.
- `floorEth <= ceilingEth`.
- `deltaEth > 0`.
- Token-specific routes still reject collection and trait target payloads rather than silently accepting incomplete shapes.
- Trait and collection targets use their dedicated automation mutation routes.

Mutation rules:

- Upsert writes `trading_jobs`, `trading_bidding_job_specs`, and the Outbox row in one SQLite transaction.
- Upsert increments `revision`.
- Upsert emits a `job_created` or `job_updated` command row in the same transaction.
- Archive marks `status = 'archived'`, sets `archived_at`, increments `revision`, and emits `job_archived` plus `cancel_active_offer` command rows in the same transaction.
- Pause, when introduced, should behave like archive for runtime scheduling and active-offer cancellation, but remain visible/editable.
- Backend publishes a best-effort JetStream wake-up after the DB transaction commits.
- JetStream payload is not authoritative business state. It may carry `job_id`, `revision`, and optionally one or more Outbox ids to speed bot processing.

## Userland UI

### Collection Page Tab

Add a `bidding` runtime tab in the collection page header after `customization`.

Route:

- `frontend/src/routes/[chain_ref]/[collection_ref]/bidding/+page.ts`
- `frontend/src/routes/[chain_ref]/[collection_ref]/bidding/+page.svelte`

View:

- `frontend/src/lib/components/CollectionBiddingView.svelte`

The collection bidding page lists the bid book above job diagnostics and exposes shared bidding operations:

- current bid-book display
- contextual bidding target controls
- shared automation panel for create/modify/pause/activate/archive
- compact read-only jobs diagnostics page
- token target rows link to token detail

Inline per-row job edit forms were replaced by the shared automation panel in `docs/progress/trading/04-bidding-automation-ux-plan.md`.

### Token Detail Form

Render the shared bidding automation panel near the bottom of the token detail page.

The token detail page renders the bid book above the inline panel because current bids are the primary user navigation surface.

Current fields and actions:

- target display
- existing job metadata
- `floorEth`
- `ceilingEth`
- `deltaEth`
- optional tier-derived pricing
- create/modify/activate/pause/archive buttons

Token detail manages the exact token target.

### Reusable Bid Book Panel

`frontend/src/lib/components/BidBookPanel.svelte` is shared by collection bidding and token detail pages.

Display rules:

- source value `orders` is labeled `normal`
- source value `bot_snapshot` is labeled `competitive`
- WETH prices omit the WETH suffix
- multi-quantity offers display as quantity times unit price
- token detail always shows scope because multiple bid scopes can apply to one token
- collection `bid_scope=collection` hides the scope column because all rows are collection-wide
- collection `bid_scope=collection` does not render trait facet controls because selected traits do not affect collection-wide bids
- collection `bid_scope=token` shows paginated explicit token-scoped offers as token cards, sorted by each token's highest explicit offer
- collection `bid_scope=traits` groups rows by exact trait-criteria bucket, then by price within each bucket
- dates default to compact relative display with RFC 3339 available on hover/toggle

## Trading Runtime Integration

### DB Runtime Job Source

The runtime uses a trading-side port:

```ts
export interface BiddingJobSource {
    loadEnabledJobs(): Promise<BidderJob[]>;
}
```

Adapters:

- new SQLite adapter maps `trading_jobs + trading_bidding_job_specs + collections` into existing `BidderJob`
- no JSON-file fallback remains

Important mapping:

- `collections.address -> BidderJob.collectionAddress`
- `collections.opensea_slug ?? collections.slug -> BidderJob.collectionSlug`
- `trading_jobs.token_id -> target.tokenId`
- `*_wei` text columns -> `bigint`
- runtime state is rebuilt from live bot state; DB runtime-state persistence is used for active-offer cancellation and diagnostics, not as declared job configuration

### Dynamic Reconciliation Pass

Runtime does not require restart after job CRUD.

Current model:

1. Backend writes job rows and command rows transactionally.
2. Backend publishes a local JetStream notification such as `trading.bidding.jobs.changed` after commit.
3. Running bidding bot receives the notification and immediately scans or claims pending Outbox rows from SQLite.
4. Bot applies reconciliation inside the runtime, not in the backend.
5. Bot also polls the DB Outbox table periodically as a recovery path for the DB-commit-to-publish gap.

Reconciliation behavior:

- Created enabled job: load job, `bidder.addJob(job)`, optionally immediate refresh after bootstrap.
- Updated enabled job: replace in-memory job, preserve safe runtime state where target identity did not change, then immediate refresh.
- Paused job: remove from scheduling and enqueue/carry out active-offer cancellation.
- Archived job: remove from scheduling and enqueue/carry out active-offer cancellation.
- Failed command: record error and retry with bounded backoff.
- Startup recovery: before normal enabled-job bootstrap, process pending cancellation commands for archived/paused jobs that still have active runtime state.
- Watch reconciliation: reload enabled jobs and update snapshot polling plus direct OpenSea stream subscriptions from the resulting collection set.

The bot owns cancellation because only the bot has the correct OpenSea SDK/client context, maker wallet, job-scoped active order knowledge, and market-operation logging.

No dedicated Outbox worker is justified yet. The bot should own both immediate event-driven Outbox processing and periodic Outbox recovery scans.

## Active Offer Cancellation Semantics

Delete in UI should mean archive, not physical row deletion.

Archive flow:

1. Backend sets `trading_jobs.status = 'archived'`.
2. Backend creates `job_archived` and `cancel_active_offer` command rows.
3. Backend emits NATS notification after commit.
4. Bot observes the command.
5. Bot removes the job from its active in-memory scheduler.
6. Bot checks persisted runtime state and in-memory job state for active order identity.
7. If active order exists, bot calls the bidding service cancellation path.
8. Bot marks the command completed and updates runtime cancellation fields.

If the bot is offline, the command remains pending. On next bot startup, command scanning should run before or alongside enabled-job loading so stale active offers are cancelled.

## Bid Book Projection

The bid-book read model is display-only and must not feed bot decisions.

Runtime projection:

1. `CollectionOfferSnapshotService` refreshes a collection offer snapshot.
2. It notifies `BiddingBidBookProjectionScheduler` without awaiting projection completion.
3. Scheduler coalesces concurrent notifications per collection.
4. Scheduler respects `BIDDING_BID_BOOK_PROJECTION_THROTTLE_MS`.
5. Projection parses snapshot offers through the shared OpenSea bidding-offer parser.
6. Projection replaces `bot_snapshot` rows for that collection in one transaction.
7. Projection updates `trading_bidding_collection_bid_book_state`.

Orders fallback:

- fallback reads active buy orders only
- fallback maps normalized order scope columns and canonical Seaport data into bid-book rows
- invalid normalized scope rows are logged explicitly and skipped
- fallback is used only when the collection has no live competitive bot snapshot source

Source selection:

- enabled collection jobs + live bidding heartbeat + fresh projection metadata -> `bot_snapshot`
- all other cases -> `orders`

## Implementation Slices

### Slice 1: Schema and Repository Contracts (done)

- Add migration `019_trading_jobs_schema.sql`.
- Add backend/trading domain contracts for persisted bidding job records.
- Add SQLite repository adapter tests.
- Do not change runtime behavior yet.

### Slice 2: Backend CRUD (done)

- Add list/get/upsert/archive use cases.
- Add HTTP adapters and route registration.
- Add API tests covering validation, transaction writes, and command outbox rows.
- Keep routes admin-only.

### Slice 3: Userland Collection Bidding Page (done)

- Add collection bidding page with bid-book display.
- Keep bidding operations in offers/bid-book and shared automation surfaces.
- Collection and trait scoped creation moved into the automation UX work.

### Slice 4: Token Detail Job Form (done)

- Add shared inline bidding automation panel at the bottom of token detail.
- Support create/update/archive for token jobs.
- Keep form compact and fit-to-content.

### Slice 5: Trading DB Job Source (done)

- Add `BiddingJobSource` port and SQLite adapter in `trading`.
- Wire bidding startup loading directly from SQLite as the only supported declared-job source.
- Remove temporary JSON-file job loading and stale desktop/env references.
- Verify existing bidder tests remain unchanged.

### Slice 6: Runtime Command Reconciliation (done)

- Add bot-side command scanner.
- Add NATS notification subscription as an accelerator.
- Add periodic DB fallback scan.
- Implement create/update/pause/archive reconciliation.
- Implement active-offer cancellation for archive/pause.
- Backend CRUD now publishes best-effort JetStream wake-up signals after command rows are committed.
- Pausing a job now emits `job_paused` plus `cancel_active_offer`, matching archive cleanup semantics.
- Runtime reconciliation reloads authoritative job state from SQLite before mutating live bidder state.
- Dynamic enabled token/collection jobs prepare direct OpenSea stream subscriptions and authoritative snapshot refreshes before immediate bid refresh.

### Slice 7: Bid Book Projection and Display (done)

- Add `trading_bidding_bid_book_rows`.
- Add `trading_bidding_collection_bid_book_state`.
- Add `trading_bot_runtime_state`.
- Project bot snapshots into bid-book display rows.
- Add orders fallback through the shared OpenSea bidding-offer parser.
- Add collection and token bid-book API routes.
- Add reusable `BidBookPanel.svelte`.

### Slice 8: Sniping Reuse

- Reuse `trading_jobs` and `trading_job_commands`.
- Add sniping-specific spec table.
- Keep sniping runtime behavior isolated from bidding-specific specs.

## Open Questions

- How much of the sniping runtime should reuse the bidding command/outbox implementation directly versus sharing only the generic trading job envelope?
- Should token-card best bids be materialized from the bid-book projection for listed tokens only, or should the UI request token bid books on demand?
