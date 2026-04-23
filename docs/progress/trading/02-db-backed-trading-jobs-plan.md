# DB-Backed Trading Jobs Plan

Status: WIP
Current milestone: planning complete

This document is the working plan for moving bidding jobs, and later sniping jobs, from operator-managed JSON files into ArtGod SQLite.

The near-term implementation is bidding-first. Sniping should reuse the same job lifecycle and command model later, but should not block the first bidding pass.

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
- Do not require dynamic runtime reconciliation in the first DB persistence slice if the DB startup loader is still being brought online.

## Hard Invariants

1. DB persistence stores declared desired job state. It must not replace the bidder's OpenSea-backed competitiveness model.
2. The bidding runtime still owns market-side effects: bid placement, cancellation, allowance checks, and OpenSea reads.
3. Backend CRUD must not call OpenSea directly and must not reach into bot internals.
4. Job changes must be durable in SQLite before any runtime signal is emitted.
5. Backend must write desired job state changes and Outbox rows in the same SQLite transaction.
6. JetStream is the low-latency wake-up path after publish. The Outbox exists specifically to close the DB-commit-to-publish gap.
7. The bot must process Outbox rows both on immediate wake-up and on periodic recovery scans.
8. Human-readable config, API, and UI values should use Ether units. Runtime internals and DB amount columns can use wei strings.
9. Delete/disable semantics must be deliberate. If a job has an active offer, the long-term behavior is to stop scheduling it and request offer cancellation.
10. The first DB runtime path may load enabled jobs on startup only, but the schema should not block dynamic reconciliation later.

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

## Proposed Schema

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

## Backend API Shape

Admin-only routes should be registered in the backend's admin route section.

Collection bidding page:

- `GET /api/:chain_ref/:collection_ref/bidding/jobs`
- Lists current bidding jobs for a collection.
- Default filters should include non-archived jobs.

Token detail management:

- `GET /api/:chain_ref/:collection_ref/:token_ref/bidding/job`
- `PUT /api/:chain_ref/:collection_ref/:token_ref/bidding/job`
- `DELETE /api/:chain_ref/:collection_ref/:token_ref/bidding/job`

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

Initial use cases:

- `ListCollectionBiddingJobsUseCase`
- `GetTokenBiddingJobUseCase`
- `UpsertTokenBiddingJobUseCase`
- `ArchiveTokenBiddingJobUseCase`

Validation rules:

- Resolve `chain_ref` through the existing chain resolver.
- Resolve `collection_ref` through the existing collection read port.
- Token job operations require the token to belong to the resolved collection.
- `floorEth`, `ceilingEth`, and `deltaEth` must parse as positive Ether amounts.
- `floorEth <= ceilingEth`.
- `deltaEth > 0`.
- For the first pass, token job CRUD must reject collection and trait target payloads rather than silently accepting incomplete shapes.

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

- `frontend/src/lib/components/CollectionBiddingJobsView.svelte`

The collection bidding page should list existing jobs for the collection and allow quick inline actions:

- inline edit `floorEth`
- inline edit `ceilingEth`
- inline edit `deltaEth`
- inline status toggle when pause is introduced
- save/cancel per row
- archive/delete per row with confirmation
- token target rows link to token detail

For the first pass, collection and competitive-trait jobs can be displayed if they exist, but their creation UI can wait.

### Token Detail Form

Add a compact token-bidding management form near the bottom of the token detail page.

First-pass fields:

- status display
- `floorEth`
- `ceilingEth`
- `deltaEth`
- save button
- archive/delete button if a job exists

This form should manage only `target.type = 'token'`.

## Trading Runtime Integration

### First DB Runtime Pass

Add a trading-side port:

```ts
export interface BiddingJobSource {
    loadEnabledJobs(): Promise<BidderJob[]>;
}
```

Adapters:

- existing JSON adapter remains available temporarily
- new SQLite adapter maps `trading_jobs + trading_bidding_job_specs + collections` into existing `BidderJob`

Config:

- add explicit `BIDDING_JOBS_SOURCE=db|file`
- keep `BIDDING_JOBS_FILE` required only when source is `file`
- default can remain `file` until the UI/API path is implemented, then switch desktop default to `db`

Important mapping:

- `collections.address -> BidderJob.collectionAddress`
- `collections.opensea_slug ?? collections.slug -> BidderJob.collectionSlug`
- `trading_jobs.token_id -> target.tokenId`
- `*_wei` text columns -> `bigint`
- runtime state should be reset on load unless and until runtime-state persistence is deliberately enabled

### Dynamic Reconciliation Pass

Long-term runtime should not require restart after job CRUD.

Clean model:

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

- Add `bidding` tab after `customization`.
- Add collection bidding jobs page.
- Add inline edit/archive actions for existing jobs.
- Keep collection and trait scoped creation out of scope.

### Slice 4: Token Detail Job Form (done)

- Add token job form at the bottom of token detail.
- Support create/update/archive for token jobs.
- Keep form compact and fit-to-content.

### Slice 5: Trading DB Job Source

- Add `BiddingJobSource` port and SQLite adapter in `trading`.
- Add `BIDDING_JOBS_SOURCE`.
- Wire startup loading from DB while preserving JSON file fallback.
- Verify existing bidder tests remain unchanged.

### Slice 6: Runtime Command Reconciliation

- Add bot-side command scanner.
- Add NATS notification subscription as an accelerator.
- Add periodic DB fallback scan.
- Implement create/update/pause/archive reconciliation.
- Implement active-offer cancellation for archive/pause.

### Slice 7: Sniping Reuse

- Reuse `trading_jobs` and `trading_job_commands`.
- Add sniping-specific spec table.
- Keep sniping runtime behavior isolated from bidding-specific specs.

## Open Questions

- Should first-pass desktop default be `BIDDING_JOBS_SOURCE=file` until CRUD UI exists, or switch to `db` as soon as the migration/API exists?
- Should archive immediately hide rows from the collection bidding page by default, or show archived rows behind a filter?
- Should pause be implemented in the first UI pass, or wait until runtime command reconciliation exists?
- Should runtime state persistence be enabled immediately, or only when cancellation recovery is implemented?
