# Order queue recovery

The domain worker processes the existing queues through normal order semantics.
It does not purge or bulk republish the backlog. This procedure is for a separately
chosen operator run; development tests use disposable databases and brokers.

## Preview

Confirm the deployed commit and that backend, indexer and desktop artifacts match.
An old binary does not service the new demand table or targeted queues. Downgrade
is not qualified: use a stopped runtime and a paired pre-upgrade SQLite/NATS
backup if rollback is needed, never restore only SQLite against a newer broker.

With the intended existing broker available, inspect a bounded sample:

```sh
yarn workspace @artgod/indexer inspect:queue -- \
  --queue order-updates-by-id --limit 2000 --samples 3
yarn workspace @artgod/indexer inspect:queue -- \
  --queue order-updates-by-maker --limit 100 --samples 3
```

The inspector uses direct stored-message reads and does not create consumers or
advance ACK floors. Explicit `--nats-url` and `--stream-prefix` override its typed
runtime environment; verify those inputs before use. A sample's classifications
are not estimates of every remaining envelope. If NATS is stopped, coordinate
startup using the existing desktop resources and exclusive store lock. Do not
start a second broker against an open store or use the application's mutating
queue adapter for read-only inspection.

With the inspector and database on the same schema version, inspect bounded
durable progress without a writer:

```sh
yarn workspace @artgod/indexer inspect:orders -- \
  --db "$ARTGOD_DB_PATH" --chain-id 1 --limit 25
```

The database path and chain are required explicit inputs. This tool opens SQLite
read-only with `query_only`; it runs no recovery or migrations and preserves WAL
semantics. It samples pending demand in scheduler order and unfinished maker
passes in recovery order. Reported ages belong to that sample, not the global
oldest work. `--counts` opts into full aggregates, including due/leased/backoff
counts, failure counts and the global oldest pending requirement age; omit it on
an unassessed large store. Requirement ages measure local admission time, not a
remote source clock. A retry-due row can still be waiting for a sampled head, an
applied collection prefix, complete signed terms or reorg recovery; the inspector
does not classify all of those readiness gates. Schema errors mean the inspected
file/version is wrong, not that there is no pending work. Never delete a WAL
manually.

Use inspector source compatible with the store's migration level. The current
inspector uses source admission sequences and the bounded maker expansion schema,
including migration 086. Use the matching older inspector for an older running
app instead of upgrading its live database merely to inspect it.
For which process drains or reaps each table, see
[processing ownership and retained state](07-domain-orders.md#processing-ownership-and-retained-state).

## Start, observe, stop

1. Agree the intended store, patched commit, an initial observation window and a
   stopping condition. A five-minute window is a useful first sample, not a
   promise to drain the backlog. Keep bidding disabled unless separately chosen.
2. Start the patched application through its normal supervisor. There is no
   separate mutating drain script and no temporary replacement consumer.
3. Compare broker pending/unacknowledged counts and durable progress at the start
   and end of the window. Inspect the by-ID, maker,
   `order-lifecycle-updates` and `order-updates-by-token` queues. Confirm that a
   new source observation makes an old current ask unusable while its demand
   waits for coordinator progress. Source observations do not change canonical
   ownership or sale activity; only accepted chain application does.
4. Stop infra through the supervisor when the chosen window ends, or earlier if
   repeated storage/RPC failures, rising useful-work age, resource pressure or a
   stuck unsupported envelope warrants review. Graceful stop finishes admitted
   operations; a forced stop can replay only uncommitted maker work or unfinished
   demand. It does not acknowledge those obligations away.
5. Resume through the same supervisor and stores. Broker cursors, maker
   checkpoints and demand generations are the saved progress. Do not reset them.

The by-ID consumer is single-flight and spaces admission by at least 5 ms
(at most 200 envelopes/second before processing cost). Time spent in SQLite makes
it slower. Source deliveries persist source-specific availability and ordinary
validation demand before ACK; no receipt lookup or validation RPC holds the
consumer slot. A source sale is an observation that sync may not have seen yet,
not a canonical terminal order fact or a claimed block requirement.

Maker and token consumers expand a finite local candidate set in pages of at
most 100 orders. Each page atomically retains ordinary demand, advances its
cursor and publishes its next continuation through the outbox. Expansion uses
no RPC permits and does not wait for sync. Its pending scope invalidates older
order proofs immediately, including candidates whose page has not yet run.
A proof covering the scope's source admission sequence or accepted canonical
requirement is usable without waiting for the remaining maker pages.

Two FIFO permits bound the unified ordinary-validation lane. Two executors yield
between batches and poll every second when idle. Each claims at most 100 ready
orders at one coordinator-approved checkpoint, stops admitting new validations
after five seconds and releases unconsumed claims. Repeated order-specific read
failures are isolated into their own retry claims; healthy demand continues.
Shared dependency and snapshot failures keep affected demand pending. These are
count/admission budgets, not deadlines for an in-flight RPC call.

Source demand waits for a head sample captured after its local admission and for
both shared chain application and that collection's applied prefix to cover the
sample. An accepted canonical event instead supplies an exact block/hash
requirement. Missing prerequisites cause no RPC retry loop and do not consume a
validation lease. Reorg dispute or recovery blocks proof use until the sync
coordinator restores its accepted lineage. The validator never adds headers or
advances sync to make its own result eligible. Maker scan completion therefore
means expansion has finished, not that every order has validated.

Do not cap the durable demand backlog by stopping on an arbitrary pending-row
count: that would bury later terminal facts behind legacy validation hints again.
Demand occupies at most one row per live order, maker coverage one row per
compatible scope, and a maker run at most one current continuation. This bounds
auxiliary cardinality by useful identities, not by six million old envelopes.
Valid orderbooks and incoming distinct work can still grow; there is no fixed
maximum database size or guarantee of recovery at every arrival rate.

## Failure and progress interpretation

Use the ten-second `Order validation demand progress` reports alongside DB
snapshots. `covered` records durable completion; `resolvedUnneeded` records
current-state skips. `validated` alone includes results rejected before commit.
For example, successful checks followed by a reorg increment `validated` and
`retried`, with no `applied` or `covered` effects. See
[field definitions](10-observability-and-metrics.md#order-validation-demand-progress).
Compare pending count and oldest age across a complete reconciliation cycle;
brief startup drainage or growth is not a steady-state throughput measurement.

For ongoing rates and bottlenecks, use the shared
[order processing metrics and APM](10-observability-and-metrics.md#order-processing-metrics-and-apm):
demand completion/retry rates, maker resolved/deferred progress, FIFO pressure,
recovery and outbox outcomes, and failure spans around validation and persistence.
The runtime does not scan whole tables to populate metrics; its sampled age
histogram complements the inspector's explicitly requested global inventory.

| Observation                                                 | Meaning and next action                                                                                                                                                                                                                                                                                                  |
| ----------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Broker queue shrinks, demand remains                        | Cheap admission is ahead of validation. Inspect pending generations, sampled age and successful validations before claiming catch-up.                                                                                                                                                                                    |
| Maker `step` / `resolvedOrders` / `deferredOrders` advances | Committed expansion progress: `resolvedOrders` counts candidates requiring no new work; `deferredOrders` counts durable ordinary-demand admissions. Neither is a successful RPC count, and deferred work may already be complete. The cursor and finite boundary survive restart; a new generation can reset the cursor. |
| A pending maker has failed/missing wakeup                   | The bounded recovery poll repairs it after its grace period using publication evidence. Inspect `lastError` and the stored queue; do not manufacture a new full sweep.                                                                                                                                                   |
| Demand stays pending without increasing failures            | Its prerequisites may be incomplete or behind sync. Inspect admission/sample and shared/collection applied progress before treating it as a failed validation.                                                                                                                                                           |
| Demand `failures` / `nextAttemptAt` increases               | RPC/storage uncertainty remains pending with bounded retry delay; it has not been treated as protocol invalidity.                                                                                                                                                                                                        |
| `Queue work failed; retry retained`                         | By-ID/lifecycle application failed. The original envelope remains with a one-second retry delay, including after five failures. Correct the underlying failure before judging throughput.                                                                                                                                |
| `Unsupported queue work retained`                           | The original envelope/bytes remain with a 60-second retry delay. Inspect its sequence/payload and review compatibility. A single-flight queue can be held up by that envelope; no automatic skip, purge or log-only DLQ transfer is authorized.                                                                          |

Unknown and malformed input is not an acknowledged no-op. Source updates ACK
only after atomic observation and demand admission, or an explicit current-state
no-work decision. Canonical cancellation is applied in the sync writer before
applied progress advances; redundant queue hints cannot replace that transaction.
A failed ACK can replay
the same domain operation without duplicating its durable obligation.

## Qualification

Use the maintained [queue fixtures](11-testing.md#heavy-maker-order-workload)
before a native run. Their fake RPC isolates scheduling and persistence; it does
not predict upstream latency, current live backlog composition or live SQLite
contention. Record envelope and useful-validation completion separately, plus
resource cost and auxiliary storage growth. Native launch, two scheduler ticks,
representative current-market/history inspection and a coordinated restart remain
the user's live qualification gate. Clearing every queue is not a release gate.
