# SQLite Storage and Recovery

Status: implemented on this branch. Native desktop startup and sustained
live-load QA remain before release.

This is the settled product and recovery design. The
[investigation](04-sqlite-wal-activities-storage-investigation.md) records the
original incident, measurements, consumer assessment and recovery benchmarks.

## 1. What Users Keep and Lose

| Data or feature                             | After this change                                                                                                                                            |
| ------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Current asks and bids                       | Keep all known valid, unexpired orders. Passive bids remain available when the bot is inactive.                                                              |
| Listings history                            | Keep one permanent daily row per NFT and seller, with its historical price. Existing per-event listing history is deleted once; daily history starts afresh. |
| Bid and cancellation history                | Delete bid-create, bid-cancel and listing-cancel history; stop recording it. These rows disappear from the API too.                                          |
| Sales, transfers and extension events       | Keep their existing details and lifetime retention.                                                                                                          |
| Artwork, NFT metadata, traits and ownership | Unchanged. Extension artifacts keep their existing representation and lifetime.                                                                              |
| Settings, wallets and bidding state         | Unchanged. Bot configuration, commands, own orders and trading cancellation evidence are not cleanup targets.                                                |
| Internal activity receipts                  | Remove `activity_sources`. It recorded processed message identities, not additional market information.                                                      |

Deleted marketplace history cannot be restored by the app. There is no
whole-database reset and no automatic destructive fallback. Cancellations still
update the orderbook; removing their historical feed entries does not disable
cancellation handling or bidding.

## 2. Listings: Permanent History, Current Orderbook

### Historical Feed

- **One row:** per chain, collection, NFT, seller and UTC day. Only a listing
  event creates it; midnight and REST snapshots do not invent history.
- **Pinned position:** use the day's first event time. Later events and price
  updates never move the row upward. A late earlier event can correct it downward.
- **Today's price:** use the lowest valid, unexpired seller ask known at the last
  update. Inbound order changes refresh an existing row in the same transaction.
- **Historical price:** preserve the last recorded price and currency after
  expiry, cancellation or sale. Later days do not overwrite it; late historical
  events use their own observed prices.
- **Permanent retention:** no time limit or count-based eviction. Do not display
  “No current ask” in place of a historical price.
- **Direct reads:** collection, token and maker feeds read the stored daily row.
  No request-time grouping over individual listing events; no separate event
  archive or raw-event count.

### Current Market Views

- The orderbook keeps multiple simultaneously valid asks or bids for the same
  NFT. Feed grouping must not remove valid orders.
- Collection asks and cards show the best valid ask per NFT across sellers.
  Read-time validity checks exclude expired orders between cleanup passes.
- Both views compare native ETH and WETH using exact integer prices. Other
  currency conversions and an offer-history projection are outside this change.
- Temporary balance or approval loss is not permanent cancellation. Recoverable
  orders remain eligible for later validation.

History grows with distinct active NFT/seller/days, not with every listing
message. Valid orderbooks and lifetime data can still grow: this is not a fixed
maximum database size.

## 3. Recovery on Upgrade

### Required Cleanup

1. Run before backend and workers start.
2. Apply migration 055 and resume saved recovery progress.
3. Delete old listing history, bid/cancel history, obsolete orders and receipts;
   rebuild retained market tables and their indexes.
4. Checkpoint through SQLite, then allow normal services to start.

Existing valid orders and lifetime data survive. Daily rows created under the
new model survive subsequent startup and maintenance.

Copy progress commits in batches of at most 500 rows. Table replacement, index
creation and receipt removal are larger atomic operations, not 500-row time
guarantees. A completed recovery does not repeat the full orderbook sweep.

### Optional Disk Shrinking

- Logical cleanup makes pages reusable; it does not necessarily reduce the file.
- A separate startup stage may run `VACUUM` after cleanup. It checks reclaimable
  pages and free space first, and records one automatic attempt.
- Skipping or failing the shrink does not undo successful logical recovery.
  It is not automatically retried on every launch.
- Never delete a WAL separately. Checkpointing and compaction belong to SQLite.

### Startup Controls

- Desktop cleanup and shrinking share a **45-minute deadline**. Progress does
  not extend it; this is a budget, not a completion-time guarantee.
- **Stop** remains available. Retry resumes committed logical progress.
- Required cleanup failure stops that launch and requires manual retry.
  Compaction failure may be logged while startup continues; Stop still cancels.
- Recovery does not unlock wallets or start bots.
- Running out of space is an accepted alpha limitation. There is no promise to
  recover an arbitrarily full or corrupt database.

### Supported Entry Points

- **Desktop:** Start infra runs recovery through the supervisor.
- **Combined development startup:** `yarn dev` runs the logical preflight.
- **Separate backend/indexer startup:** stop clients, select the intended
  `ARTGOD_DB_PATH`, then run `yarn storage:recover` before starting writers.
- **Docker:** use the approved
  [manual stop → recover → start procedure](../deploy/01-web-hosted-read-only.md#sqlite-storage-upgrade).
  It uses the deployment's existing data volume. Compose does not automate it.

These are mutating recovery commands, not inspection tools. Users do not need
to clone the database or manipulate offline storage before desktop recovery.

## 4. Maintenance During Long Uptime

The **indexer-domain-worker** owns one non-overlapping, **20-minute** cycle.

### Order Cleanup

- Select obsolete orders through indexes, in batches of at most 500.
- Yield between batches; stop starting new batches after two seconds.
  An individual synchronous batch may exceed that budget.
- Remove expired orders; give terminal and source-inactive orders a one-hour
  grace. Unknown-expiry orders have a 24-hour observation lifetime.
- Refresh today's existing listing prices as time-based validity changes.
  Retain the previous price if no valid ask remains; never delete daily history.
- Clean expired cancellation markers even when the orderbook is empty.
  An empty cleanup pass does not open a writer transaction.

This timer handles expiry without new messages. Inbound order changes already
update prices immediately; they do not wait for the timer.

### Less Repeated Work

- Identical canonical payload/status writes become no-ops. Observation and
  validation freshness remain separate from material state changes.
- Routine freshness and repeat validation use five-minute intervals; explicit
  maker/state changes can still trigger validation.
- Maker validation and REST reconciliation page through candidates instead of
  materializing the entire orderbook.
- Queued creation observations older than 24 hours are rejected. This is not a
  24-hour lifetime for valid orders or listing history: fresh REST observations
  can discover long-lived orders. Delayed cancellations of known orders still apply.
- Expiring order-specific markers prevent cancelled orders returning through
  delayed creation messages. They retain no canonical order payload. Explicit
  OpenSea cancellations survive unrelated chain rollback.

Details: [orders](../indexer/07-domain-orders.md#current-state-retention-and-replay)
and [activities](../indexer/09-domain-activities.md#permanent-daily-listings).

## 5. Storage Diagnostics and Limits

### Warnings

Every 20 minutes, the same domain-worker cycle reads WAL file size and filesystem
free space. **No SQL, checkpoint, compaction or writer lock is used.**

- Warn below **20 GiB free** or at **2 GiB allocated WAL**.
- Repeat an ongoing warning at most once every **six hours**.
- Write to `indexer-domain-worker-YYYY-MM-DD.log`, action
  `market-data-maintenance`. There is no UI alert.
- A large allocated WAL is a space observation, not proof of failed checkpointing.
  These thresholds provide early notice, not a guaranteed day's remaining capacity.

### Separate Storage Controls

Values are owned by
[`MARKET_DATA_STORAGE_POLICY`](../../shared/market-data/storage-policy.ts).

| Control                       | Current value                                             | Effect                                                                                                                               |
| ----------------------------- | --------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| Reusable WAL allocation       | 64 MiB                                                    | Limits leftover allocation when SQLite can reset the WAL. Does not trigger a checkpoint or cap active WAL growth.                    |
| Minimum worthwhile compaction | 1 GiB reclaimable                                         | Makes optional startup compaction eligible; it is not a periodic trigger.                                                            |
| Recovery free-space floor     | 1 GiB                                                     | Refuses another logical recovery batch below this free space. It is not the warning threshold or a guarantee that recovery will fit. |
| Compaction headroom           | Three times estimated live pages, plus the recovery floor | Skips optional shrinking if estimated scratch space is unavailable.                                                                  |

## 6. Verification and Remaining Work

### Verified Locally

- Recovery on disposable copies reduced the preserved database from **51.77 GiB
  to 2.09 GiB**. All 52 protected-table fingerprints matched. The later
  daily-history copy run also passed full `integrity_check`.
- Real-SQLite tests cover spam, duplicate writes, expiry, retained prices, UTC
  boundaries, cancellations, indexed cleanup and migration retry.
- Bundled recovery tests cover committed WAL, hard interruption, resume and
  repeat startup. Rendered browser tests cover listing prices and navigation.
- The final migration cleanup passed 147 tests and backend/indexer type checks.
  Merge preparation passed 27 storage/diagnostic tests, including free-space
  boundaries and skipping compaction for small savings. Earlier results are in the
  [verification record](04-sqlite-wal-activities-storage-investigation.md#verification-record).

Original databases were not modified by implementation testing. Copy benchmarks
predate the final review fixes; they are not final-branch native startup proof.

### Still Required Before Release

1. Native desktop **Start infra → recovery → healthy services**, including retry.
2. Sustained real marketplace/RPC input with collection browsing.
3. Supported-platform packaging/runtime QA.
4. Execute the documented Docker procedure on the managed deployment.

### Deliberately Deferred

- **Exact feed totals:** daily grouping is precomputed, but total counts still
  scan retained history. Changing the API/UI pagination contract is separate work.
- **Validation after deletion/reinsertion:** the revision guard protects updates
  to an existing row, but does not cover replacement of that row while RPC work is
  outstanding. This exceptional rollback-related case remains deferred.
- **Full collection shutdown/purge coordination:** market-row fences do not
  settle every producer, bot command or marketplace bid. See `BKL-064` and
  `BKL-065` in the [backlog](../planning/01-unified-backlog.md).

This branch does not claim to have established the old frontend stall's exact
cause, nor to cover arbitrary corruption or every power-loss boundary.
