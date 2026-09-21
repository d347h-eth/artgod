# SQLite Storage Investigation

Measurements: August 11–14 and September 18, 2026. Recovery tests: September
19–21. This is the evidence record, not an implementation plan. The
[storage and recovery design](03-sqlite-storage-and-recovery.md) owns current
behavior, operator procedures and remaining release work.

## Main Findings

- **95.98% of the preserved 51.77 GiB database** belonged to activities, orders
  and activity-source receipts.
- **98.68% of activity rows were bid creation/cancellation history.** The normal
  UI had no bid-history journey. Most inspected priced buy orders were expired.
- **Receipts contained no additional market facts.** Their 4.775 GiB maintained
  duplicate-event bookkeeping for the old mutable projector.
- **Index cost amplified unwanted history:** activities occupied 7.905 GiB of
  table data and 15.211 GiB of indexes.
- **SQLite successfully processed the original 57.06 GiB WAL.** The preserved
  database passed a read-only structural check. The WAL was not simply discarded.
- **Recovery worked on copies:** the later daily-history implementation reduced
  51.77 GiB to 2.09 GiB while preserving all 52 protected-table fingerprints.
- **Not established:** the exact historical WAL growth mechanism, the original
  collection-page stall's cause, or damage caused by moving the files to Qubes.

## Incident and Evidence Boundaries

- The release app opened, but Start infra failed to reach healthy services.
  Collection main pages had also become unusually slow.
- A fresh SQLite database did not resolve startup while the old NATS store
  remained. The NATS issue was investigated and fixed separately: recorded
  recovery reduced roughly 30 GiB to 2.8 GiB and 34,051,950 messages to
  2,797,061 after applying the intended 24-hour queue expiry.
- App data initially occupied about 146 GiB, with about 10–11 GiB free. A later
  checkpoint-time observation showed 151 GiB available on a 378 GiB volume.
  These are different observation times, not an attribution of all reclaimed space.
- The files originated on Ubuntu and were copied with `qvm-copy` into a Fedora
  Qubes AppVM. The source volume was read-only during copying. Missing permission
  metadata alone does not explain millions of distinct market events; the copy's
  complete crash-consistency state was not independently established.
- The original stopped-app checkpoint was explicitly authorized. Later review
  used read-only originals; implementation tests mutated disposable copies only,
  under the authorized 100 GB working allowance. No new scan is implied by this
  consolidated report.

Inspection paths use `<app-data-dir>/sqlite/main.backup/db` for the preserved
snapshot and `<app-data-dir>/sqlite/main/db` for the newer instance. The preserved
file had no remaining WAL after checkpointing. The newer read-only pass included
its WAL; its subsequent timestamps changed, so its figures are dated observations.

Source baselines were `217e5c8b28115c5294c36bd5d64acdd2e78ea601` for the original
trace and `2545284e4608fdb33b34a1413fcf39e75c1cfd37` for the September consumer
review. Implementation was rebased onto `main` at `d1810833`. Historical query
and write-path findings below describe the old implementation.

## What the Data Was Used For

### Activities: Useful History Mixed with Bid Churn

- **Useful:** Sales, Listings, Transfers and extension-event collection/token
  feeds; historical context for extension previews.
- **Not authoritative for:** ownership, current orderbooks or bidding decisions.
- **No normal UI journey:** bid-create/cancel or listing-cancel history.
  The generic unfiltered API could still return those rows; removing them is an
  intentional API behavior change, not merely hiding an unused screen.
- **Settled outcome:** retain sale/transfer/extension detail and permanent daily
  listings. Remove bid/cancellation history and per-order listing history.

The old projection coalesced small reprices while reads independently grouped
listings by day. Neither mechanism was a user requirement to preserve. The final
daily row represents the listing seen that day, not every transport message or
price change.

### Orders: Current Market State, Not a Lifetime Archive

| Consumer              | Information needed                                                                                                            |
| --------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| Passive bidbook       | Current valid bids, normalized scope, maker, price, quantity, currency, validity and protocol address; works without the bot. |
| Collection asks/cards | Current valid token asks and best prices.                                                                                     |
| Indexer validator     | Complete canonical Seaport data for fillability checks.                                                                       |
| Maker-change triggers | Makers with current or recoverable orders that may need revalidation.                                                         |

The bidding bot's placement and competitiveness authority uses direct OpenSea
reads and its in-memory state, not historical canonical orders. Its commands,
own-order records and cancellation evidence live separately in `trading_*`.
See [trading authority](../trading/03-market-data-and-scaling.md).

Expired orders do not serve these current views. Temporary approval or balance
loss can recover, so it is not equivalent to permanent cancellation. Full
Seaport payloads remain valuable for retained validation; raw debug suppression
alone was not the demonstrated fix.

Synthetic unminted tokens cannot have valid orders. An old order-existence
retirement guard did not justify preserving obsolete orders or inventing a
historical evidence table. The separate
`collection_extension_synthetic_token_retirements` records remain: they prevent
delayed jobs from recreating synthetic rows after minting.

### Activity Sources: Duplicate-Event Receipts

The entire stored information was:

- `chain_id`, `source_kind`, `source_name`, `source_event_key`: event identity;
- `activity_id`: the activity created or updated;
- `id`, `created_at`: local bookkeeping.

No payload, price, previous value, participant history or order status was stored.
It could not reconstruct coalesced-away history.

The projector read only whether a receipt existed before mutation, then inserted
one after processing. Collection purge followed its activity link. No production
UI response, trading decision or market-data reader consumed the receipts;
`id` and `created_at` had no production read consumer in the reviewed trace.

Why it existed: event A could create a row, then reprice B could mutate that row
while it kept A's dedupe key. A separate receipt remembered B. However, the old
code wrote a receipt for ordinary one-event/one-row cases too.

| Receipt measurement                       |      Count |
| ----------------------------------------- | ---------: |
| Receipt rows                              | 15,975,400 |
| Distinct referenced activity IDs          | 15,770,489 |
| Referenced IDs with more than one receipt |    185,692 |
| Receipts beyond one per referenced ID     |    204,911 |
| Maximum receipts for one referenced ID    |        130 |

Only **1.28%** were additional mappings beyond one receipt per referenced ID.
The aggregate did not test every foreign-key/key correspondence: it was not
permission to delete 98.72% without changing projection semantics.

A bare table drop would have broken old statements and replay guards around
side effects. The settled implementation instead removes rejected event
production, defines idempotent daily identity and removes both receipt reads
and writes. Retained activities still carry their own source attribution.

## Database Populations

All sizes use binary MiB/GiB; a table family includes its indexes.

| Measurement                      | Preserved snapshot | Newer database |
| -------------------------------- | -----------------: | -------------: |
| Main file bytes                  |     55,589,523,456 | 13,361,197,056 |
| Main file GiB                    |              51.77 |          12.44 |
| Activities                       |         15,771,020 |      2,411,445 |
| Orders                           |          8,808,310 |      1,561,934 |
| Activity sources                 |         15,975,400 |      2,536,151 |
| Inspected priced buy orders      |          8,681,086 |      1,140,956 |
| Expired within that population   |          8,607,446 |      1,137,779 |
| Expired share                    |             99.15% |         99.72% |
| Freelist pages, 4,096 bytes each |                  0 |        404,316 |
| Auto-vacuum                      |               NONE |           NONE |

Order sample predicate: `chain_id=1`, `side='buy'`, nonempty/non-null
`price`. Expiry meant a positive `valid_until` before the snapshot's last
activity: `1786418739` (August 11, 03:25:39 UTC) or `1789675066`
(September 17, 19:57:46 UTC). These percentages are **not all orders** and do not
use the later review clock.

The first 20,000 physical orders in each file had empty raw REST/stream debug
fields; canonical Seaport JSON averaged about 1.2–1.4 KB across status groups.
This was a non-random sample, not a population-wide payload measurement.

### Newer Database

| Family                 |   GiB |
| ---------------------- | ----: |
| Orders                 | 4.126 |
| Activities             | 3.738 |
| Extension artifacts    | 1.221 |
| Activity sources       | 0.807 |
| Token metadata         | 0.394 |
| Collection sync blocks | 0.318 |
| Blocks                 | 0.151 |

- Structures occupied about 10.90 GiB; the freelist another 1.54 GiB.
- Bid events: 1,704,404. Listing create/cancel events: 705,575. Together:
  **99.94% of activities**.
- Terraforms alone: 2,195,849 activities and 1,394,380 orders. Heavy Chromie/Remilio
  traffic was not necessary for substantial accumulation.
- 5,517 orders referenced missing collections 5/6; 30 activities referenced missing
  collection 5. This proves leftovers, not their cause or deleted collection names.
- Extension artifacts were intentionally lifetime data and were excluded from
  optimization, despite appearing among the larger families.

## Physical Allocation by Table Family

The allocation report used SQLite's `dbstat` virtual table in aggregate mode.
Every index was attributed to its owning table. Units are binary MiB/GiB. The
database file totaled `53,014.3 MiB` (`51.772 GiB`) and had zero freelist pages.

| Table family                                       | Table MiB | Index MiB | Total MiB | Total GiB | Database |
| -------------------------------------------------- | --------: | --------: | --------: | --------: | -------: |
| `activities`                                       |   8,095.2 |  15,576.0 |  23,671.2 |    23.116 |   44.65% |
| `orders`                                           |  17,432.6 |   4,889.6 |  22,322.2 |    21.799 |   42.11% |
| `activity_sources`                                 |   2,407.4 |   2,482.6 |   4,890.0 |     4.775 |    9.22% |
| `token_extension_artifacts`                        |   1,249.0 |       1.0 |   1,250.0 |     1.221 |    2.36% |
| `token_metadata`                                   |     423.5 |       4.0 |     427.5 |     0.417 |    0.81% |
| `token_sets_tokens`                                |      59.9 |      99.8 |     159.7 |     0.156 |    0.30% |
| `token_attributes`                                 |      37.1 |      56.2 |      93.3 |     0.091 |    0.18% |
| `collection_sync_blocks`                           |      47.3 |      29.8 |      77.1 |     0.075 |    0.15% |
| `blocks`                                           |      34.3 |       3.0 |      37.3 |     0.036 |    0.07% |
| `nft_balances`                                     |      10.1 |      11.3 |      21.5 |     0.021 |    0.04% |
| `token_image_cache`                                |       8.1 |       5.0 |      13.1 |     0.013 |    0.02% |
| `trading_bidding_order_cancellations`              |       6.9 |       5.4 |      12.3 |     0.012 |    0.02% |
| `tokens`                                           |       4.2 |       5.6 |       9.8 |     0.010 |    0.02% |
| `trading_bidding_bid_book_rows`                    |       5.1 |       3.2 |       8.3 |     0.008 |    0.02% |
| `transactions`                                     |       4.1 |       0.1 |       4.2 |     0.004 |    0.01% |
| `bootstrap_image_cache_tasks`                      |       3.3 |       0.4 |       3.6 |     0.004 |    0.01% |
| `attributes`                                       |       2.1 |       1.0 |       3.1 |     0.003 |    0.01% |
| `collection_trait_stats`                           |       1.6 |       0.8 |       2.5 |     0.002 |   <0.01% |
| `opensea_orderbook_runs`                           |       0.6 |       1.3 |       1.9 |     0.002 |   <0.01% |
| `collection_extension_synthetic_token_retirements` |       1.0 |       0.7 |       1.6 |     0.002 |   <0.01% |
| `token_sets`                                       |       1.1 |       0.5 |       1.6 |     0.002 |   <0.01% |
| `trading_job_commands`                             |       0.6 |       0.2 |       0.8 |     0.001 |   <0.01% |
| `trading_jobs`                                     |       0.1 |       0.2 |       0.3 |    <0.001 |   <0.01% |
| `nft_transfer_events`                              |       0.1 |       0.1 |       0.2 |    <0.001 |   <0.01% |
| `fills`                                            |       0.1 |       0.1 |       0.2 |    <0.001 |   <0.01% |
| `trading_bidding_job_runtime_state`                |       0.2 |       0.0 |       0.2 |    <0.001 |   <0.01% |
| `trading_bidding_job_specs`                        |       0.1 |       0.0 |       0.2 |    <0.001 |   <0.01% |
| `sqlite_schema`                                    |       0.1 |       0.0 |       0.1 |    <0.001 |   <0.01% |

The following table families each rounded below `0.1 MiB` in both table and
index allocation:

- `bootstrap_run_events`
- `collections`
- `bootstrap_run_steps`
- `metadata_refresh_runs`
- `queue_outbox`
- `collection_extension_events`
- `attribute_keys`
- `bootstrap_collection_extension_artifact_tasks`
- `trading_bidding_price_tiers`
- `bootstrap_metadata_snapshot_tasks`
- `bootstrap_ownership_snapshot_tasks`
- `offchain_order_observations`
- `collection_extension_event_media`
- `metadata_refresh_extension_artifact_tasks`
- `trading_bidding_runtime_authorized_collections`
- `trading_bot_runtime_state`
- `bootstrap_runs`
- `chains`
- `collection_customization_features`
- `collection_extension_installs`
- `collection_scope_tokens`
- `nft_balance_snapshots`
- `seaport_conduit_channels`
- `seaport_conduits`
- `app_settings`
- `collection_settings`
- `migrations`
- `sync_state`
- `trading_bidding_collection_bid_book_state`
- `sqlite_sequence`

The top three table families accounted for `95.98%`; the top five accounted for
`99.15%`. All indexes across the database occupied approximately `22.63 GiB`,
or `43.7%` of the file.

## `activities` Index Inventory

The `activities` table contained `15,771,020` rows. Ten explicit indexes plus
the unique autoindex held `173,480,891` entries in total. The maker partial index
excluded only 329 rows; every other index contained one entry per activity row.

The exact indexed keys in the snapshot were:

- `sqlite_autoindex_activities_1`:
  `UNIQUE (chain_id, dedupe_key)`.
- `activities_collection_feed_idx`:
  `(chain_id, collection_id, occurred_at DESC, id DESC)`.
- `activities_token_feed_idx`:
  `(chain_id, collection_id, token_id, occurred_at DESC, id DESC)`.
- `activities_contract_token_idx`:
  `(chain_id, contract_address, token_id)`.
- `activities_order_idx`: `(chain_id, order_id)`.
- `activities_open_create_idx`: `(chain_id, collection_id,
contract_address, token_id, kind, maker, side, currency, is_open,
occurred_at DESC, id DESC)`.
- `activities_collection_kind_feed_idx`:
  `(chain_id, collection_id, kind, occurred_at DESC, id DESC)`.
- `activities_collection_extension_event_feed_idx`: `(chain_id,
collection_id, kind, source_kind, source_name,
json_extract(payload_json, '$.eventKey'), occurred_at DESC, id DESC)`.
- `activities_collection_maker_feed_idx`:
  `(chain_id, collection_id, maker, occurred_at DESC, id DESC)` with
  `WHERE maker IS NOT NULL`.
- `activities_collection_content_hash_feed_idx`: `(chain_id, collection_id,
LOWER(COALESCE(json_extract(payload_json, '$.contentHash'), '')),
occurred_at DESC, id DESC)`.
- `activities_collection_event_group_feed_idx`: `(chain_id, collection_id,
LOWER(COALESCE(json_extract(payload_json, '$.eventGroup'), '')),
occurred_at DESC, id DESC)`.

| Index                                            |   GiB |     MiB |    Entries | Avg payload bytes | Payload | Unused | Max payload |
| ------------------------------------------------ | ----: | ------: | ---------: | ----------------: | ------: | -----: | ----------: |
| `activities_open_create_idx`                     | 4.813 | 4,928.2 | 15,771,020 |             170.0 |   51.9% |  46.6% |         182 |
| `sqlite_autoindex_activities_1`                  | 2.174 | 2,226.2 | 15,771,020 |             126.3 |   85.3% |  12.2% |         128 |
| `activities_collection_maker_feed_idx`           | 1.619 | 1,657.6 | 15,770,691 |              61.0 |   55.4% |  41.6% |          62 |
| `activities_order_idx`                           | 1.309 | 1,340.0 | 15,771,020 |              74.5 |   83.6% |  12.7% |          75 |
| `activities_collection_extension_event_feed_idx` | 1.166 | 1,194.4 | 15,771,020 |              49.1 |   61.8% |  34.1% |          55 |
| `activities_contract_token_idx`                  | 0.942 |   964.9 | 15,771,020 |              54.4 |   84.8% |  10.2% |          60 |
| `activities_collection_kind_feed_idx`            | 0.852 |   872.4 | 15,771,020 |              31.1 |   53.6% |  41.0% |          37 |
| `activities_token_feed_idx`                      | 0.706 |   722.9 | 15,771,020 |              22.9 |   47.7% |  45.7% |          29 |
| `activities_collection_content_hash_feed_idx`    | 0.551 |   564.2 | 15,771,020 |              19.0 |   50.7% |  41.0% |          20 |
| `activities_collection_event_group_feed_idx`     | 0.551 |   564.2 | 15,771,020 |              19.0 |   50.7% |  41.0% |          20 |
| `activities_collection_feed_idx`                 | 0.528 |   540.9 | 15,771,020 |              18.0 |   50.1% |  41.2% |          19 |

Approximately `5.18 GiB` of the current activity indexes was internally unused
B-tree page space. This is not the database freelist: those pages are owned by
the indexes and cannot be reclaimed as free database pages without rebuilding
the affected B-trees. It also must not be added to proposed index-drop savings,
because the two estimates overlap.

### Why the Indexes Were Disproportionate

- `activities_open_create_idx`: **4.813 GiB**, indexing 15,771,020 rows to
  support only 6,357 currently open creates.
- Three extension/filter indexes: **2.268 GiB**, despite zero custom activities.
  Empty JSON expressions still occupied index entries.
- Order and contract/token activity indexes: **2.251 GiB**. No production reader
  requiring those contracts was found in the reviewed repository.
- Those categories totaled 9.332 GiB gross. This overlaps the 5.18 GiB internally
  unused space above; adding them would overstate reclaimable bytes.
- No `sqlite_stat1` existed: persistent planner statistics were absent at
  inspection. This does not prove `ANALYZE` had never run.
- Targeted `EXPLAIN QUERY PLAN` probes could use all matching indexes. That
  proved usability, not business value or bounded production query cost.

The final design removes obsolete open-create/order/contract indexes, narrows
extension indexes to custom activity and keeps indexes serving retained feeds.
It does not change extension artifacts or their retention.

## Activity Row Distribution

Exact kind counts were:

| Kind                |           Rows |    Share |
| ------------------- | -------------: | -------: |
| `bid_created`       |      7,913,623 |   50.18% |
| `bid_cancelled`     |      7,649,402 |   48.50% |
| `listing_cancelled` |        118,165 |    0.75% |
| `listing_created`   |         89,299 |    0.57% |
| `transfer`          |            329 |   <0.01% |
| `sale`              |            202 |   <0.01% |
| `custom`            |              0 |       0% |
| **Total**           | **15,771,020** | **100%** |

Bid activity alone accounted for `15,563,025` rows (`98.68%`). This was not a
generic NFT transfer-history explosion or extension-event explosion.

### Collection Concentration

| Collection                                 |  ID | Activity rows |  Share |
| ------------------------------------------ | --: | ------------: | -----: |
| Chromie Squiggle                           |  26 |     9,259,969 | 58.72% |
| Remilio Babies                             |  18 |     5,108,134 | 32.39% |
| Project Aeon                               |  19 |       936,293 |  5.94% |
| Terraforms                                 |  17 |       335,632 |  2.13% |
| Anticyclone                                |  24 |        59,314 |  0.38% |
| Meridian                                   |  25 |        45,860 |  0.29% |
| Memories of Qilin                          |  23 |        20,788 |  0.13% |
| Milady Aura2: After Death                  |  20 |         2,870 |  0.02% |
| Etudes                                     |  14 |         1,013 |  0.01% |
| Collection without a matching current slug |   2 |           799 |  0.01% |
| Collection without a matching current slug |   6 |           200 | <0.01% |
| Gumbo                                      |  16 |           112 | <0.01% |
| Sketchbook B                               |  15 |            35 | <0.01% |
| Collection without a matching current slug |   1 |             1 | <0.01% |

Chromie Squiggle and Remilio Babies together accounted for `14,368,103` rows,
or `91.10%` of the table.

### Order-ID Multiplicity

| Metric                              |      Value |
| ----------------------------------- | ---------: |
| Rows with `order_id`                | 15,770,691 |
| Rows without `order_id`             |        329 |
| Distinct order IDs                  |  8,359,776 |
| Average rows per order ID           |      1.886 |
| Order IDs with one row              |    950,107 |
| Order IDs with two rows             |  7,408,464 |
| Order IDs with more than two rows   |      1,205 |
| Rows on IDs with more than two rows |      3,656 |
| Maximum rows on one order ID        |          4 |

Millions of distinct orders and mostly one/two rows per order support ordinary
create/cancel churn, not a simple loop inserting one corrupt record. They do not
exclude every replay issue.

### Why Old Coalescing Did Not Bound Growth

- Exact source-event receipts blocked exact redelivery.
- Small reprices below 1,000,000,000,000,000 wei could update an open row.
- Larger reprices and creates after cancellation produced new rows.
- Every cancellation remained separate history. Neither receipts nor coalescing
  imposed retention.

| Coalescing metric        |     Value |
| ------------------------ | --------: |
| Create rows              | 8,002,922 |
| Distinct coalescing keys |    23,972 |
| Average rows per key     |   333.845 |
| Keys with one row        |     8,846 |
| Keys with multiple rows  |    15,126 |
| Rows on multi-row keys   | 7,994,076 |
| Maximum rows on one key  |    12,930 |
| Currently open rows      |     6,357 |

An old cancellation could also close a newer replacement in the same bucket
without matching its order identity. This was a reproduced code-path defect,
not evidence that it caused the reported slowdown.

## WAL Recovery and Its Limits

### Original File Measurements

| File/state                              |              Bytes or count |
| --------------------------------------- | --------------------------: |
| Main file before checkpoint             | 55,569,907,712 (51.754 GiB) |
| WAL                                     | 61,264,264,072 (57.057 GiB) |
| SHM before recovery                     |                   1,605,632 |
| SQLite page size                        |                       4,096 |
| Complete physical WAL frames            |                  14,869,967 |
| Main pages before checkpoint            |                  13,566,872 |
| Last physical frame's commit-page count |                  13,571,661 |
| Main file after checkpoint              |              55,589,523,456 |
| Main-file growth                        |       19,615,744 (18.7 MiB) |

WAL header magic was `0x377f0682`; salts were `0x1dfed16b` and
`0x871f5f93`. After the 32-byte header, 4,096-byte pages plus 24-byte frame
headers divided evenly into the file. The last physical frame began at
61,264,259,952 and referred to page 13,571,191.

Matching endpoint salts and frame alignment were not a full checksum or
generation validation. The main file may already have contained checkpointed
pages. **The 18.7 MiB growth does not prove that all remaining WAL bytes were
repeated updates, nor that 57 GiB still required checkpointing.**

### Authorized Checkpoint

The stopped-app checkpoint used the bundled `better-sqlite3` SQLite 3.53.1:

```sql
PRAGMA wal_checkpoint(TRUNCATE);
```

- Total elapsed: **323.8 seconds**; pragma execution: **251,958 ms**.
  The remaining time included opening/recovery.
- SHM grew to 118,980,608 bytes during recovery.
- Result: `{busy:0, log:0, checkpointed:0}`.
- Final main size matched the observed commit-page count; sidecars disappeared
  after clean closure. Their later absence beside the backup was not evidence
  of an independently deleted, unprocessed WAL.

The recovered header had page count 13,571,661; change counter and version-valid
number 1,624,040; schema version 231; schema format 4; UTF-8; 234 schema objects;
56 migration records; and zero freelist pages.

Read-only `quick_check` using system SQLite 3.50.2 returned `ok` in
**1,738 seconds (28m 58s)**. It checked structure, not every index/UNIQUE
relationship or application meaning. The original WAL was not retained, so its
historical checkpoint blocker cannot now be reconstructed.

### Newer WAL: Size Was Not Outstanding Work

At the September inspection, the newer WAL occupied **1,997,355,432 bytes
(1.86 GiB)** but its current generation had only **598 frames (about 2.35 MiB)**.
The WAL index reported zero backfilled frames. Current-frame salts matched the
header; the physical tail belonged to older generations.

SQLite can retain WAL allocation for reuse after checkpoint/reset. Therefore,
file size alone cannot diagnose an active backlog or a pinned reader. The
implemented periodic diagnostics report allocation only; they do not infer a
checkpoint failure.

With `auto_vacuum=NONE`, deleting rows creates reusable database pages, not
automatic filesystem shrinkage. Checkpointing, logical deletion and `VACUUM`
solve different problems.

## Query and Write Evidence

### Query Costs

| Offline measurement                          | Result                                  |
| -------------------------------------------- | --------------------------------------- |
| Newer Terraforms listing history             | 299,408 creates collapsed to 362 groups |
| Indexed 101-row page                         | 0.001 s                                 |
| Old whole-history windowed listing page      | 1.887 s                                 |
| Separate collapsed count                     | 1.696 s                                 |
| Preserved collection 24 asks before recovery | 3,744.95 ms                             |
| Preserved collection 26 asks before recovery | Did not finish within the bounded check |

The first four measurements used system SQLite 3.50.2, 64 MiB cache,
memory-backed temporary storage and warm filesystem state. They are offline
query comparisons, not browser p95 measurements.

The collection main page fetched details, bidding tiers and runtime config—not
the activity feed. Sales was the normal activity default. Thus the old listing
query was demonstrably expensive, but it did not establish the original
main-page or health-probe failure's cause.

### Avoidable Write Paths

The old source trace showed:

1. Bid history added activity jobs, rows and receipts beside required order work.
2. Each activity maintained eleven indexes; each receipt maintained two.
   Coalescing still updated indexed fields and inserted another receipt.
3. Identical order upserts rewrote canonical JSON and `updated_at`.
4. Validation and source-status updates wrote even when status did not change.
5. Maker-triggered queries lacked expiry filtering; selected candidates were
   materialized in memory and revalidated.
6. Obsolete makers remained in watch sets, sustaining otherwise unnecessary work.

These are verified code paths, not physical-write percentages or attribution of
the lost WAL. The final changes remove unwanted production, exclude obsolete
candidates and distinguish state changes from freshness.

## Recovery Benchmarks

All runs below used disposable copies. Protected-table verification compared
row counts and streaming SHA-256 fingerprints for **52 tables**. Originals'
inode, size and modification time stayed unchanged during implementation tests.

| Run                                                      | Main file before → after                                | End-to-end QA time   | Retained state                                                     |
| -------------------------------------------------------- | ------------------------------------------------------- | -------------------- | ------------------------------------------------------------------ |
| September 19, bundled preserved copy                     | 55,589,523,456 → 2,241,654,784 bytes (51.77 → 2.09 GiB) | 1,421.64 s (23m 42s) | 12,195 orders; 202 sales; 329 transfers                            |
| September 19, bundled newer copy including WAL           | 13,361,197,056 → 2,339,856,384 bytes (12.44 → 2.18 GiB) | 269.86 s (4m 30s)    | 1,111 orders; 437 sales; 1,016 transfers; 22 extension events      |
| Later daily-history implementation, fresh preserved copy | 51.77 → 2.09 GiB                                        | About 24.5 minutes   | 12,008 orders; 202 sales; 329 transfers; old listing history reset |

- September 19 runs removed 24,566,604 and 3,971,723 obsolete activity/order rows
  respectively, plus receipts. All fingerprints matched and `quick_check=ok`.
- Preserved-copy compaction reclaimed 53,348,302,848 bytes from its post-recovery
  55,589,957,632-byte file. New recovery/index bookkeeping explains its small
  difference from the original size.
- An earlier source-mode recovery took 1,446.30 seconds; separate compaction and
  verification took 92.91 seconds, producing 2,241,159,168 bytes. These are
  separate runs, not additional stages of the bundled result.
- Bundled idempotent rechecks took 31.42 and 45.33 seconds, including hashes and
  structural checks. Sizes stayed unchanged; compaction reported already attempted.
- The later daily-history copy also passed full `integrity_check`, preserved all
  52 fingerprints and passed repeat startup without another rebuild or compaction.

September 19 measurements describe an earlier implementation, not today's
permanent-history semantics. The later daily-history copy predates the final
review fixes. Large-copy recovery was not repeated after those fixes.

### Reads After Recovery

- September 19 bundled preserved copy: asks **1.49–10.85 ms** across 11 collections;
  collections 24/26 took 3.51/3.64 ms.
- Newer copy: asks **1.52–19.04 ms**, collection lookup **0.04–0.27 ms** and trait
  facets **0.21–28.38 ms** across four collections.
- Later daily-history copy: slowest asks read **18.72 ms** across 11 collections.
- Post-recovery plans selected `orders_active_token_sell_lookup_idx` instead of
  the old broad `orders_collection_token_idx`.

These are single local read-model samples using aged snapshots and the then-current
clock—not sustained API/browser performance guarantees.

## Verification Record

### Large-Copy and Interrupted-Recovery Coverage

- A verifier correction made bundled preflight strictly read-only. Its earlier
  read-write preflight could checkpoint the copied newer WAL before recovery.
- The original 57 GiB WAL was unavailable. A separate synthetic bundled harness
  left committed WAL by killing its own writer, then interrupted recovery after
  cursor 500 committed.
- September 19 fixture: 2,270,152 WAL bytes from 6,000 synthetic rows.
  September 21 fixture: 2,331,952 WAL bytes. Both resumed, preserved settings,
  passed structural checks and completed an idempotent retry.
- Injected failures cover migration interruption, table-cutover failure,
  insufficient space and a pinned WAL reader. They do not cover arbitrary
  corruption or every filesystem/power-loss boundary.

### Behavioral Coverage

- 1,000 identical recently validated order upserts: no additional SQLite changes
  or WAL bytes in the deterministic fixture; real external-state validation remains.
- 400 simulated active days: all 400 daily rows survive.
- 1,000 same-day listing events: no extra unchanged history writes.
- More than 10,000 simultaneously valid orders: no count-cap eviction.
- Final review regressions cover historical prices, delayed cancellations,
  source cancellation through rollback, marker-only cleanup, idle cleanup without
  a writer transaction and no repeated completed-startup sweep.
- Plans confirm indexed cleanup and four maker-pagination queries without
  temporary sorting. Filesystem diagnostics tests confirm no SQL/checkpoint.

### Dated Test Runs

| Checkpoint                       | Recorded result                                                                                                                       |
| -------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| September 19 broad suites        | Shared 202; backend 379; indexer 424 excluding external smoke; trading 330; frontend 452                                              |
| September 19 packaging/native    | Six runtime suites/40 tests; six native recovery tests plus bridge/readiness serialization                                            |
| September 19 rendered QA         | 16 Playwright cases, including recovery, retry, Stop and compaction at 480/768 px                                                     |
| September 21 review fixes        | Indexer 442 excluding Docker smoke; backend API/passive bidbook 130; shared activity/card reads 31                                    |
| September 21 listing UI          | Two maintained Playwright cases; rendered review of same-day updates, historical prices, empty state, paging and live-asks navigation |
| Final migration/evidence cleanup | 47 indexer, 94 backend API and 6 shared tests; indexer/backend type checks; documentation checks                                      |

- September 19 concurrent heavy I/O caused API-setup and accelerated-soak timeouts;
  isolated reruns passed without weakening their limits.
- The September 21 shared/indexer/backend type checks and Userland/runtime builds
  passed. Svelte had zero errors and 86 existing warnings. Broader indexer test-fixture
  type checking still had unrelated existing errors.
- Older browser cases covering discarded price behavior are not proof of the
  final UI. The two September 21 listing cases cover the retained-price behavior.
- External NATS/RPC smoke coverage was not established: configuration and AppVM
  Docker access constrained it. Child-output checks also needed the ordinary host
  test environment after reproducible sandbox output loss.

September 22 merge preparation passed **27 storage/diagnostic tests**, including
the approved recovery-floor boundary and skipping compaction for small savings.
All 14 documentation-validator tests, verification of 74 Markdown files and the
runtime-registry check passed. This did not rerun large-copy, native desktop or
deployment QA.

Maintained verification commands are in
[local development](01-local-development.md#sqlite-storage-recovery-verification).
Local artifacts are under `tmp/sqlite-storage-qa/` and
`tmp/runtime-recovery-playwright/`; they are not required user recovery inputs.
Native Start-to-healthy, sustained live ingress, supported platforms and the
manual Docker procedure remain distinct QA obligations in the
[design](03-sqlite-storage-and-recovery.md#6-verification-and-remaining-work).

## Detailed Activity Evidence

### Dominant Bid Rates

| Collection        | Kind            |      Rows | First UTC           | Last UTC            | Average rows/day |
| ----------------- | --------------- | --------: | ------------------- | ------------------- | ---------------: |
| Chromie Squiggle  | `bid_created`   | 4,695,736 | 2026-08-08 01:45:10 | 2026-08-11 03:25:38 |      1,529,671.0 |
| Chromie Squiggle  | `bid_cancelled` | 4,564,043 | 2026-08-08 01:45:20 | 2026-08-11 03:25:39 |      1,486,821.5 |
| Remilio Babies    | `bid_created`   | 2,590,158 | 2026-07-31 21:10:56 | 2026-08-11 03:25:39 |        252,446.6 |
| Remilio Babies    | `bid_cancelled` | 2,476,404 | 2026-07-31 21:11:09 | 2026-08-11 03:25:38 |        241,363.6 |
| Project Aeon      | `bid_created`   |   454,518 | 2026-08-05 22:21:33 | 2026-08-11 03:25:22 |         87,223.1 |
| Project Aeon      | `bid_cancelled` |   435,442 | 2026-08-05 22:21:34 | 2026-08-11 03:25:24 |         83,562.2 |
| Terraforms        | `bid_cancelled` |   110,209 | 2026-07-29 20:22:02 | 2026-08-11 03:25:23 |          8,964.5 |
| Terraforms        | `bid_created`   |   108,518 | 2026-07-29 20:21:21 | 2026-08-11 03:24:55 |          8,826.8 |
| Anticyclone       | `bid_created`   |    30,306 | 2026-08-07 22:28:54 | 2026-08-11 03:25:25 |          9,453.2 |
| Anticyclone       | `bid_cancelled` |    28,993 | 2026-08-07 22:27:33 | 2026-08-11 03:25:32 |          9,040.7 |
| Meridian          | `bid_created`   |    23,138 | 2026-08-07 22:38:51 | 2026-08-11 03:24:59 |          7,233.6 |
| Meridian          | `bid_cancelled` |    22,696 | 2026-08-07 22:37:43 | 2026-08-11 03:25:22 |          7,093.0 |
| Memories of Qilin | `bid_cancelled` |    10,916 | 2026-08-07 20:32:51 | 2026-08-11 03:25:29 |          3,321.4 |
| Memories of Qilin | `bid_created`   |     9,865 | 2026-08-07 20:32:46 | 2026-08-11 03:16:06 |          3,007.5 |

Chromie Squiggle alone was receiving about 3.02 million create/cancel rows per
day over the measured interval.

### Complete Collection/Kind Counts

The full nonzero collection/kind breakdown was:

| Collection                |  ID | Kind                |      Rows |
| ------------------------- | --: | ------------------- | --------: |
| Chromie Squiggle          |  26 | `bid_created`       | 4,695,736 |
| Chromie Squiggle          |  26 | `bid_cancelled`     | 4,564,043 |
| Remilio Babies            |  18 | `bid_created`       | 2,590,158 |
| Remilio Babies            |  18 | `bid_cancelled`     | 2,476,404 |
| Project Aeon              |  19 | `bid_created`       |   454,518 |
| Project Aeon              |  19 | `bid_cancelled`     |   435,442 |
| Terraforms                |  17 | `bid_cancelled`     |   110,209 |
| Terraforms                |  17 | `bid_created`       |   108,518 |
| Terraforms                |  17 | `listing_cancelled` |    66,385 |
| Terraforms                |  17 | `listing_created`   |    50,370 |
| Anticyclone               |  24 | `bid_created`       |    30,306 |
| Anticyclone               |  24 | `bid_cancelled`     |    28,993 |
| Project Aeon              |  19 | `listing_cancelled` |    26,799 |
| Remilio Babies            |  18 | `listing_cancelled` |    23,195 |
| Meridian                  |  25 | `bid_created`       |    23,138 |
| Meridian                  |  25 | `bid_cancelled`     |    22,696 |
| Project Aeon              |  19 | `listing_created`   |    19,507 |
| Remilio Babies            |  18 | `listing_created`   |    18,143 |
| Memories of Qilin         |  23 | `bid_cancelled`     |    10,916 |
| Memories of Qilin         |  23 | `bid_created`       |     9,865 |
| Milady Aura2: After Death |  20 | `listing_cancelled` |     1,629 |
| Milady Aura2: After Death |  20 | `listing_created`   |     1,147 |
| No matching current slug  |   2 | `bid_created`       |       665 |
| Etudes                    |  14 | `bid_created`       |       496 |
| Etudes                    |  14 | `bid_cancelled`     |       494 |
| No matching current slug  |   6 | `bid_created`       |       169 |
| Remilio Babies            |  18 | `transfer`          |       144 |
| No matching current slug  |   2 | `bid_cancelled`     |       134 |
| Terraforms                |  17 | `transfer`          |        96 |
| Chromie Squiggle          |  26 | `listing_cancelled` |        95 |
| Remilio Babies            |  18 | `sale`              |        90 |
| Chromie Squiggle          |  26 | `listing_created`   |        75 |
| Terraforms                |  17 | `sale`              |        54 |
| Milady Aura2: After Death |  20 | `transfer`          |        39 |
| Gumbo                     |  16 | `listing_cancelled` |        37 |
| Milady Aura2: After Death |  20 | `sale`              |        35 |
| Gumbo                     |  16 | `listing_created`   |        34 |
| No matching current slug  |   6 | `bid_cancelled`     |        31 |
| Gumbo                     |  16 | `bid_cancelled`     |        23 |
| Milady Aura2: After Death |  20 | `bid_created`       |        20 |
| Sketchbook B              |  15 | `bid_cancelled`     |        17 |
| Gumbo                     |  16 | `bid_created`       |        17 |
| Sketchbook B              |  15 | `bid_created`       |        16 |
| Project Aeon              |  19 | `transfer`          |        16 |
| Chromie Squiggle          |  26 | `transfer`          |        13 |
| Etudes                    |  14 | `listing_cancelled` |        12 |
| Meridian                  |  25 | `listing_cancelled` |        12 |
| Etudes                    |  14 | `listing_created`   |        11 |
| Project Aeon              |  19 | `sale`              |        11 |
| Anticyclone               |  24 | `transfer`          |         9 |
| Meridian                  |  25 | `transfer`          |         7 |
| Chromie Squiggle          |  26 | `sale`              |         7 |
| Memories of Qilin         |  23 | `listing_created`   |         4 |
| Meridian                  |  25 | `listing_created`   |         4 |
| Memories of Qilin         |  23 | `transfer`          |         3 |
| Anticyclone               |  24 | `listing_created`   |         3 |
| Meridian                  |  25 | `sale`              |         3 |
| Anticyclone               |  24 | `sale`              |         2 |
| No matching current slug  |   1 | `bid_created`       |         1 |
| Sketchbook B              |  15 | `listing_created`   |         1 |
| Sketchbook B              |  15 | `transfer`          |         1 |
| Gumbo                     |  16 | `transfer`          |         1 |
| Anticyclone               |  24 | `listing_cancelled` |         1 |

### Maker Concentration

Chromie Squiggle's top five makers were:

| Maker                                        | Activity rows |
| -------------------------------------------- | ------------: |
| `0x878203083dc13041f511d5e312e42c2d0b2c5d09` |     3,142,879 |
| `0xc19dc40f81aa9bfeda63f26ccd33aa465e7aa61a` |     2,493,542 |
| `0x2950a053b11248f7ab8f728a2e529a926724d026` |     1,919,994 |
| `0x4157bff0e1fd6fe0b7e2f0e964c3e341524f5aab` |       974,514 |
| `0xc7ab26377965ce81ea0b69c24e58fdb693a9e295` |       686,564 |

Those five makers generated `9,217,493` of `9,259,969` Chromie rows
(`99.54%`).

The largest Remilio makers were:

| Maker                                        | Activity rows |
| -------------------------------------------- | ------------: |
| `0x5fcdf9ed1ce4483dd2f389e7e0629e2b6ff6707c` |     1,083,826 |
| `0x6339ed11fff5be5bb26d0466e97c8cabf2a9daa8` |       953,133 |
| `0xa7c53fbc17d92bc8753f16bc95dd91aeeee60b9b` |       679,908 |
| `0xef28b4f7d1281af0b9bddd453900a6d1691da733` |       505,381 |
| `0x5bfd6f5e488a101a62fa290c5826c9c34d638f5a` |       489,737 |
| `0x68d43dbd259782c4d40d04e2f6cf0a5483c4e434` |       411,371 |
| `0x2950a053b11248f7ab8f728a2e529a926724d026` |       373,011 |
| `0x20a73210d00de31548388669e87a9f3095354aef` |       184,947 |
| `0x144f4869af8040028cf09aa7a50923bfccb46221` |        69,573 |
| `0x8971d1eacd5fba65526c441101a302c51337a96c` |        65,306 |
| `0xc19dc40f81aa9bfeda63f26ccd33aa465e7aa61a` |        41,533 |
| `0x8e1c7d120c7f64cbbff5794e75cc0f6bc7c434ce` |        38,998 |
| `0xeccf4d0ca6f0b2202ad1773accacd91711a4aeb7` |        27,666 |
| `0x09c26ecc2be4646322da20af13fe19a48c87604a` |        24,963 |
| `0x478818924d4eb945df38ac4d64f291b0edfebe9a` |        23,365 |

Sample rows at the end of the observed range alternated rapidly among
`item_received_bid`, `item_cancelled`, and `order_invalidate` events across many
token IDs. Order hashes were distinct, a few makers recurred, and many received
bids had short validity windows. That shape is consistent with marketplace bot
churn rather than repeated insertion of one corrupt record.

## Reproducible Read-Only Inspection

These queries reproduce the **legacy snapshot** measurements, including tables
and indexes removed by recovery. Do not run them as startup health checks.
Full index scans and structural checks can take many minutes.

Set a task-specific path to a stopped, immutable inspection copy:

```sh
export ARTGOD_DB_INSPECT_PATH='<app-data-dir>/sqlite/main.backup/db'
```

Do not use `immutable=1` against a file that is still changing. It suppresses
normal locking assumptions and can hide relevant WAL state. First stop all
writers, establish whether a WAL belongs to the database, and checkpoint through
SQLite when recovery is authorized.

### Header and Structural State

```sh
sqlite3 -readonly -header -tabs \
  "file:${ARTGOD_DB_INSPECT_PATH}?mode=ro&immutable=1" \
  'PRAGMA query_only=ON;
   SELECT sqlite_version() AS reader_sqlite_version;
   PRAGMA page_size;
   PRAGMA page_count;
   PRAGMA freelist_count;
   PRAGMA schema_version;
   SELECT COUNT(*) AS schema_objects FROM sqlite_schema;
   SELECT COUNT(*) AS applied_migrations FROM migrations;'
```

### Quick Structural Check

```sh
sqlite3 -readonly \
  "file:${ARTGOD_DB_INSPECT_PATH}?mode=ro&immutable=1" \
  'PRAGMA query_only=ON;
   PRAGMA temp_store=MEMORY;
   PRAGMA quick_check;'
```

### Allocation by Owning Table

```sql
PRAGMA query_only=ON;
PRAGMA temp_store=MEMORY;

WITH object_sizes AS (
    SELECT name, pgsize AS bytes
    FROM dbstat
    WHERE aggregate = TRUE
),
attributed AS (
    SELECT
        COALESCE(s.tbl_name, o.name) AS table_name,
        SUM(CASE WHEN s.type = 'index' THEN 0 ELSE o.bytes END) AS table_bytes,
        SUM(CASE WHEN s.type = 'index' THEN o.bytes ELSE 0 END) AS index_bytes
    FROM object_sizes AS o
    LEFT JOIN sqlite_schema AS s ON s.name = o.name
    GROUP BY COALESCE(s.tbl_name, o.name)
),
sized AS (
    SELECT
        table_name,
        table_bytes,
        index_bytes,
        table_bytes + index_bytes AS total_bytes
    FROM attributed
)
SELECT
    table_name,
    ROUND(table_bytes / 1048576.0, 1) AS table_mib,
    ROUND(index_bytes / 1048576.0, 1) AS indexes_mib,
    ROUND(total_bytes / 1048576.0, 1) AS total_mib,
    ROUND(total_bytes / 1073741824.0, 3) AS total_gib,
    ROUND(100.0 * total_bytes / SUM(total_bytes) OVER (), 2) AS accounted_pct
FROM sized
ORDER BY total_bytes DESC;
```

Run the SQL through:

```sh
sqlite3 -readonly -header -tabs \
  "file:${ARTGOD_DB_INSPECT_PATH}?mode=ro&immutable=1"
```

### Activity Index Allocation and Packing

```sql
PRAGMA query_only=ON;
PRAGMA temp_store=MEMORY;

WITH index_stats AS (
    SELECT name, pgsize AS bytes, ncell, payload, unused, mx_payload
    FROM dbstat
    WHERE aggregate = TRUE
      AND name IN (
          SELECT name
          FROM sqlite_schema
          WHERE type = 'index' AND tbl_name = 'activities'
      )
)
SELECT
    name,
    ROUND(bytes / 1073741824.0, 3) AS gib,
    ROUND(bytes / 1048576.0, 1) AS mib,
    ncell,
    ROUND(payload * 1.0 / NULLIF(ncell, 0), 1) AS avg_payload_bytes,
    ROUND(100.0 * payload / NULLIF(bytes, 0), 1) AS payload_pct,
    ROUND(100.0 * unused / NULLIF(bytes, 0), 1) AS unused_pct,
    mx_payload
FROM index_stats
ORDER BY bytes DESC;
```

### Activity Kind and Collection Distribution

```sql
SELECT kind, COUNT(*) AS rows
FROM activities
GROUP BY kind
ORDER BY rows DESC;

SELECT chain_id, collection_id, COUNT(*) AS rows
FROM activities INDEXED BY activities_collection_feed_idx
GROUP BY chain_id, collection_id
ORDER BY rows DESC;
```

### Order-ID Multiplicity

```sql
WITH per_order AS (
    SELECT order_id, COUNT(*) AS rows_per_order
    FROM activities INDEXED BY activities_order_idx
    WHERE chain_id = 1 AND order_id IS NOT NULL
    GROUP BY order_id
)
SELECT
    SUM(rows_per_order) AS rows_with_order_id,
    COUNT(*) AS distinct_order_ids,
    ROUND(AVG(rows_per_order), 3) AS rows_per_order_id,
    SUM(rows_per_order = 1) AS order_ids_with_1_row,
    SUM(rows_per_order = 2) AS order_ids_with_2_rows,
    SUM(rows_per_order > 2) AS order_ids_with_over_2_rows,
    SUM(CASE WHEN rows_per_order > 2 THEN rows_per_order ELSE 0 END)
        AS rows_on_over_2_order_ids,
    MAX(rows_per_order) AS max_rows_one_order_id
FROM per_order;
```

### Coalescing-Key Multiplicity

```sql
WITH per_key AS (
    SELECT
        collection_id,
        contract_address,
        token_id,
        kind,
        maker,
        side,
        currency,
        COUNT(*) AS rows_per_key,
        SUM(is_open = 1) AS open_rows
    FROM activities INDEXED BY activities_open_create_idx
    WHERE chain_id = 1
      AND kind IN ('listing_created', 'bid_created')
    GROUP BY
        chain_id,
        collection_id,
        contract_address,
        token_id,
        kind,
        maker,
        side,
        currency
)
SELECT
    SUM(rows_per_key) AS create_rows,
    COUNT(*) AS distinct_coalescing_keys,
    ROUND(AVG(rows_per_key), 3) AS rows_per_key,
    SUM(rows_per_key = 1) AS keys_with_1_row,
    SUM(rows_per_key > 1) AS keys_with_multiple_rows,
    SUM(CASE WHEN rows_per_key > 1 THEN rows_per_key ELSE 0 END)
        AS rows_on_multiple_keys,
    MAX(rows_per_key) AS max_rows_one_key,
    SUM(open_rows) AS currently_open_rows
FROM per_key;
```

The literal activity kinds in this query reproduce the existing storage/domain
contract; they are not a proposal to define new stringly typed behavior.

### Receipt Multiplicity

This is an index scan over roughly 16 million legacy receipts, not a cheap probe.

```sql
PRAGMA query_only = ON;
PRAGMA temp_store = MEMORY;

SELECT
    COUNT(*) AS referenced_activity_ids,
    SUM(n) AS source_rows,
    SUM(n > 1) AS activity_ids_with_multiple_receipts,
    SUM(n - 1) AS additional_receipts,
    MAX(n) AS maximum_receipts
FROM (
    SELECT activity_id, COUNT(*) AS n
    FROM activity_sources INDEXED BY activity_sources_activity_idx
    GROUP BY activity_id
);
```

## References

- Historical schema: `database/migrations/005_activities_schema.sql` and
  `029_activity_feed_query_indexes.sql`.
- Current owners: [orders](../indexer/07-domain-orders.md),
  [activities](../indexer/09-domain-activities.md) and
  [storage schema](../indexer/05-storage-and-schema.md#market-data-storage-lifecycle).
- SQLite: [WAL operation](https://www.sqlite.org/wal.html),
  [WAL-index format](https://www.sqlite.org/walformat.html),
  [checkpoint results](https://www.sqlite.org/pragma.html#pragma_wal_checkpoint),
  [dbstat allocation](https://www.sqlite.org/dbstat.html),
  [check scope](https://www.sqlite.org/pragma.html#pragma_quick_check),
  [VACUUM](https://www.sqlite.org/lang_vacuum.html).

The runtime reported SQLite 3.53.1; the read-only system CLI reported 3.50.2.
No SQLite engine defect was established as the incident's cause.
