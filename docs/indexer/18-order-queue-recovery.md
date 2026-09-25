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

After migrations 056–060, inspect bounded durable progress without a writer:

```sh
yarn workspace @artgod/indexer inspect:orders -- \
  --db "$ARTGOD_DB_PATH" --chain-id 1 --limit 25
```

The database path and chain are required explicit inputs. This tool opens SQLite
read-only with `query_only`; it runs no recovery or migrations and preserves WAL
semantics. It samples pending demand in scheduler order and unfinished maker
passes in recovery order. Reported ages belong to that sample, not the global
oldest work. `--counts` opts into full aggregate counts; omit it on an unassessed
large store. Schema errors mean the inspected file/version is wrong, not that
there is no pending work. Never delete a WAL manually.

## Start, observe, stop

1. Agree the intended store, patched commit, an initial observation window and a
   stopping condition. A five-minute window is a useful first sample, not a
   promise to drain the backlog. Keep bidding disabled unless separately chosen.
2. Start the patched application through its normal supervisor. There is no
   separate mutating drain script and no temporary replacement consumer.
3. Compare broker pending/unacknowledged counts and durable progress at the start
   and end of the window. Inspect both old queues and the new
   `order-lifecycle-updates` / `order-updates-by-token` queues. Confirm an observed
   sale loses its current ask while ownership, sale activity and daily listing
   history remain correct. Refresh the API/UI after its normal cache interval.
4. Stop infra through the supervisor when the chosen window ends, or earlier if
   repeated storage/RPC failures, rising useful-work age, resource pressure or a
   stuck unsupported envelope warrants review. Graceful stop finishes admitted
   operations; a forced stop can replay only uncommitted maker work or unfinished
   demand. It does not acknowledge those obligations away.
5. Resume through the same supervisor and stores. Broker cursors, maker
   checkpoints and demand generations are the saved progress. Do not reset them.

The legacy by-ID consumer is single-flight and spaces admission by at least 5 ms
(at most 200 envelopes/second before processing cost). Time spent in SQLite makes
it slower. This bounds ingestion work while two FIFO permits bound RPC across
individual-order demand, broad-maker and token validation. A demand poll claims
at most 100 orders and shares a pinned snapshot, stopping new validation after
five seconds and releasing unconsumed claims. Maker steps admit at most 100 orders or
five seconds and atomically publish their next continuation through the outbox.
These are count/admission budgets, not deadlines for an in-flight RPC call.

Do not cap the durable demand backlog by stopping on an arbitrary pending-row
count: that would bury later terminal facts behind legacy validation hints again.
Demand occupies at most one row per live order, maker coverage one row per
compatible scope, and a maker run at most one current continuation. This bounds
auxiliary cardinality by useful identities, not by six million old envelopes.
Valid orderbooks and incoming distinct work can still grow; there is no fixed
maximum database size or guarantee of recovery at every arrival rate.

## Failure and progress interpretation

| Observation                                   | Meaning and next action                                                                                                                                                                                                                         |
| --------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Broker queue shrinks, demand remains          | Cheap admission is ahead of validation. Inspect pending generations, sampled age and successful validations before claiming catch-up.                                                                                                           |
| Maker `step` / `resolvedOrders` advances      | Committed progress; the cursor and finite boundary survive restart. A follow-up generation can legitimately reset the cursor.                                                                                                                   |
| A pending maker has failed/missing wakeup     | The bounded recovery poll repairs it after its grace period using publication evidence. Inspect `lastError` and the stored queue; do not manufacture a new full sweep.                                                                          |
| Demand `failures` / `nextAttemptAt` increases | RPC/storage uncertainty remains pending with bounded retry delay; it has not been treated as protocol invalidity.                                                                                                                               |
| `Queue work failed; retry retained`           | By-ID/lifecycle application failed. The original envelope remains with a one-second retry delay, including after five failures. Correct the underlying failure before judging throughput.                                                       |
| `Unsupported queue work retained`             | The original envelope/bytes remain with a 60-second retry delay. Inspect its sequence/payload and review compatibility. A single-flight queue can be held up by that envelope; no automatic skip, purge or log-only DLQ transfer is authorized. |

Unknown and malformed input is not an acknowledged no-op. Known terminal facts
ACK only after normal domain application; ordinary hints ACK only after durable
admission or an explicit current-state no-work decision. A failed ACK can replay
the same domain operation without duplicating its durable obligation.

## Qualification

Use the maintained [queue fixtures](11-testing.md#heavy-maker-order-workload)
before a native run. Their fake RPC isolates scheduling and persistence; it does
not predict upstream latency, current live backlog composition or live SQLite
contention. Record envelope and useful-validation completion separately, plus
resource cost and auxiliary storage growth. Native launch, two scheduler ticks,
representative current-market/history inspection and a coordinated restart remain
the user's live qualification gate. Clearing every queue is not a release gate.
