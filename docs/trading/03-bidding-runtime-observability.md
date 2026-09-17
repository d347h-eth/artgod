# Bidding Runtime Observability

This document is the operator reference for the local bidding metrics endpoint
and the provisioned `ArtGod Bidding Runtime Overview` Grafana dashboard. The
bidding runtime and its safety boundaries remain documented in
`docs/trading/01-bidding-runtime-and-jobs.md`.

## Public-Alpha Scope and Safety

Bidding metrics are an opt-in diagnostic surface. They are disabled by default
and do not change bidding decisions, wallet authorization, or OpenSea request
policy.

For installed desktop builds:

- Admin exposes only the `bidding metrics endpoint` toggle and the
  `bidding metrics TCP port`.
- Rust always binds the endpoint to numeric IPv4 loopback `127.0.0.1`; the host
  is not editable in Admin, and a persisted non-loopback value is overwritten
  before the bot starts.
- The endpoint serves `GET /healthz` and `GET /metrics` only on this computer.
- A bind or metrics-initialization failure does not block the fund-sensitive
  bidding runtime. The bot logs an actionable warning and continues without
  metrics for that process.

The desktop exception is deliberately narrow. Backend and indexer metrics, and
all desktop tracing and profiling exporters, remain disabled in desktop
artifacts. Only the trading metrics facade may reach the reviewed Prometheus
runtime; the desktop build rejects bypasses into the full metrics barrel or APM
implementations.

Local and deploy runtime profiles still use the typed env settings
`TRADING_METRICS_ENABLED`, `TRADING_METRICS_HOST`, and
`TRADING_METRICS_PORT_BIDDING_BOT`. The native loopback override applies to the
installed desktop composition, not those separately operated profiles.

## Enable Metrics in Desktop Admin

The complete desktop journey is:

1. Open Admin `config`, select the `advanced` view, and find
   `Trading Observability`.
2. Turn on `bidding metrics endpoint`.
3. Keep `bidding metrics TCP port` at `42753` unless another local process owns
   that port. The value is one local TCP port and must be a whole number from
   `1` through `65535`.
4. Save the configuration.
5. Ensure ArtGod infrastructure is running, then finish the normal wallet
   assignment and collection/cap selection.
6. If the bidding bot is already running, stop it. A bot process reads this
   setting only at start, so saving does not retrofit an endpoint into the
   active process.
7. Start the bot and complete the normal native unlock and bidding-authorization
   review. Metrics become available while that new process is running.

An invalid port highlights the setting, shows the exact recovery message in its
warning tip, and disables `save`. If a valid port is already occupied, the bot
continues bidding without the endpoint. Free the port and restart the bidding
bot to retry. Disabling the toggle and restarting the bot removes the optional
listener.

The repository Prometheus target is `127.0.0.1:42753`. If an operator chooses a
different valid port, they must update the `artgod-trading` target in
`observability/prometheus/prometheus.yml` to the same loopback port. A later
`yarn observability:up` uses the edited target. If the stack is already running,
restart that collector:

```sh
docker compose --profile observability restart prometheus
```

## Start the Local Dashboard

The repository-owned observability stack supplies Prometheus and Grafana:

```sh
yarn observability:up
```

Then verify the path in order:

1. Open `http://127.0.0.1:42753/healthz`; it should return `ok` while the
   metrics-enabled bot is running.
2. Open `http://127.0.0.1:42753/metrics`; it should include
   `artgod_trading_bidding_...` series.
3. In Prometheus, query
   `up{job="artgod-trading",runtime="bidding-bot"}` and require a value of
   `1`.
4. Open Grafana at `http://127.0.0.1:42735` and select
   `ArtGod Bidding Runtime Overview`.
5. Use the `worker` and `chain_id` dashboard selectors when more than one
   series is present.

Use `yarn observability:stop` to stop the local observability containers and
`yarn observability:down` to remove only those service containers. These
commands do not stop the ArtGod desktop runtime or bidding bot.

## Reading the Dashboard

The dashboard is arranged in the same order that work moves through the
bidding process.

### Runtime Health, Capacity, and Dynamic Scans

Start with runtime state, time to ready, bootstrap phase duration,
process-lifetime failures, active pressure, and the critical-path comparison.
The capacity panels place live concurrency, queue caps, and cadences beside
current job counts. Startup phase duration is the current bot process's
lifetime average for each completed phase, not a rate-window percentile. A
startup failure can close the optional endpoint before Prometheus scrapes it,
so the structured startup log remains authoritative for failed bootstrap.

The process-lifetime failure panel uses raw counters rather than rates. That
keeps a first or singleton failure visible even if it happened before the first
Prometheus baseline scrape. These totals reset with the bidding bot process.
Command failures in this panel count failed processing attempts, including
attempts scheduled for retry.

Long-operation and event-age histograms cover sub-second observations through
24 hours. `Measurements Beyond Histogram Range` shows the percentage of
completed observations above each measurement's largest finite bucket, per bot
and chain, with the measurement unit and boundary in its legend. Only positive
overflow appears. A percentile outside its recorded range is omitted from the
p95 charts, so it cannot appear as a misleading fixed latency. Compare a missing
p95 with this overflow panel before treating it as an idle runtime. A hung
operation has not completed a duration observation; use active pressure and
structured logs to inspect work that is still running.

This guard is needed because classic Prometheus histograms otherwise return the
highest finite boundary when the requested quantile falls in the infinite
bucket. See [Prometheus histogram quantiles](https://prometheus.io/docs/prometheus/latest/querying/functions/#histogram_quantile).

`Job Scan Duration p95` measures a complete dynamic scan of the current job
inventory. `Jobs Found in Latest Scan` shows its size. Scan results distinguish
a fully successful pass, a pass that completed with one or more job failures,
an operational failure, and a scan stopped during shutdown. Rising scan time
with a stable job count points to slower per-job work; rising scan size and
refresh pressure points to inventory growth or insufficient configured concurrency.

### Commands to Strategy

Three timings separate durable command backlog from strategy contention:

- `Command Queue Wait p95`: command creation to claim.
- `Command Claimed to Strategy Start p95`: claim to the actual start of that
  job's strategy work.
- `Command Created to Strategy Start p95`: the complete creation-to-strategy
  interval.

High queue wait with low claimed-to-strategy time indicates polling, batch, or
durable backlog pressure. Low queue wait with high claimed-to-strategy time
indicates contention after claim, such as job refresh concurrency or other
admitted work. Compare both with command attempt duration, reconciliation
pass duration, batch size, and commands in flight before changing a cadence.

`Command Processing Attempts` and `Command Attempt Duration p95` describe one
processing attempt, not the final outcome of a unique durable command. The
`bidding_command_attempts_total` counter records two failures and one success
when one command fails twice before succeeding. Both retryable and terminal
attempt failures use the failure result; structured command logs retain the
authoritative retry or terminal outcome.

### Job Refreshes and Marketplace Actions

Refresh request outcomes show whether a refresh was admitted or coalesced behind
work for the same job. Shutdown rejects new background refreshes. Queue wait,
duration, and active/waiting/pending gauges expose concurrency pressure without
identifying a job. Marketplace action rate and duration are split by bounded
action, target type, result, and dry-run state.

### Inbound Marketplace Pressure

Inbound event rate, event age, dispatch duration, and active dispatches show
whether OpenSea events arrive late or occupy the process for too long. The
hot-refresh panels then show bounded broad/item lanes, pending events and
signals, active and known lanes, queue wait, pass duration, and events/signals
coalesced into each pass.

Hot-refresh pass concurrency uses `BIDDING_MAX_CONCURRENT_JOBS`. For either
lane kind, let `M` be that kind's configured maximum pending signatures and
let `C` be `BIDDING_MAX_CONCURRENT_JOBS`; known lane identity is bounded by
`2 * M + C` across retained cooldowns, pending work, and active passes. The
cooldown registry retains at most `M` recently completed identities. Under a
sustained unique-identity flood, retaining a newer cooldown forgets the oldest
one, so that oldest identity may run before its prior cooldown would have
expired. This deliberate pressure trade-off keeps memory bounded while the
active-pass and pending-signature limits continue to cap expensive work.

Sustained pending or known-lane growth while active work stays flat means
inbound pressure is accumulating. Coalesced outcomes are expected under repeat
traffic. Dropped or evicted outcomes mean a configured pending-signal cap was
reached; use the event rate, pass duration, process CPU, and event-loop delay to
decide whether the source is a short burst or resource monopolization.

### OpenSea Work and Local Rate Limits

OpenSea operation duration measures the API/SDK call itself. Local rate-limit
wait and queue depth are separate, so provider latency is not confused with
ArtGod's own rate limiter. The panels split operations, retries, and waits by
the bounded OpenSea lane, operation, request priority, and result.

An expected OpenSea absence, such as no best offer or an order that is already
missing, is a normal business result. It is not counted as a provider failure
or retry. Malformed stream payloads are counted as normalization failures and
kept out of the bidding pipeline.

High rate-limit wait with ordinary operation duration points to local request
pressure. High operation duration with little rate-limit wait points to the
OpenSea or network path. Command-priority and background work remain visible as
separate priority series.

### Marketplace Offer Sync and Bid-Book Updates

Offer-sync panels report request decisions, duration, page and offer counts,
in-flight/pending work, and aggregate watched collections. Finished syncs are
split into `complete`, `partial`, and `error`.

A response that OpenSea marks incomplete, or whose cursor repeats, fails
closed and is recorded as `partial`. A page request that exhausts retries is
recorded as `error` while preserving the completed page and offer counts. In
both cases the result is not stored or published as a fresh authoritative
snapshot, cannot replace the previous complete snapshot, and cannot trigger a
bid-book update. The collection enters the existing refresh-failure backoff
and retries later. This keeps an interrupted pagination walk from being
mistaken for a complete market view.

Bid-book update panels show request decisions, queue wait for every pass,
duration, rows written, and active/pending reruns. Queue wait includes both
immediate and coalesced work. Compare these with offer-sync completion and size
to separate marketplace fetch cost from local bid-book update cost.

### Shutdown and Process Resources

Shutdown first closes background bidder admission and discards coalesced
reruns. Background work waiting on concurrency or a job lock rechecks admission
before strategy execution and is discarded. It then closes durable-command
admission and finishes admitted commands, including their required strategy work,
before removing stream subscriptions and draining captured callbacks.
Active event batches and job refreshes settle before active offer syncs, and
active offer syncs settle before active bid-book writes. Work that is still
queued or coalesced in background stages is discarded when that stage closes
admission. Already-executing strategy work may finish its placement or cancellation.
The shared OpenSea stream disconnects only after those ordered drain
attempts finish. This prevents a durable command from being acknowledged while
its strategy work is abandoned without making shutdown wait for superseded
background signals.

Runtime state changes to `shutting_down` and remains the last pull-based state;
there is no reliable final sample after the exporter exits. The final duration,
result, error count, and primary error are instead written to the structured
`shutdownComplete` log, which is authoritative for shutdown completion.

Process uptime, resident memory, CPU usage, and p99 event-loop delay provide the
resource context for every queue and latency panel. Metrics reset when the bot
process restarts, so compare a pressure event with the dashboard time range and
uptime before treating a counter reset as recovery.

## Metric Identity and Cardinality

Bidding-specific metrics use the `artgod_trading_` prefix and the shared
`worker=bidding-bot` and `chain_id` labels. Runtime labels are bounded enums or
aggregate values such as action, command kind, event type/scope, lane,
operation, priority, result, target type, and trigger.

Metrics and dashboard queries intentionally do not label or group by wallet,
address, collection id/slug, job id, order id/hash, or token id. Those values
would create unbounded Prometheus series and expose user-specific identities in
an aggregate diagnostic surface. Use structured bidding logs for a specific
job, collection, token, order, or failure, then return to metrics to determine
whether it is isolated or system-wide.

The dashboard generator rejects unknown bidding metric names, queries that use
the forbidden high-cardinality labels above (including negative matchers), and
legends that omit worker or chain identity under multi-value selectors.

## Dashboard Generation and Drift Check

The editable source is
`scripts/observability/generate-bidding-runtime-dashboard.ts`. It owns the
PromQL, layout, panel text, allowed metric vocabulary, and cardinality check.
The generated Grafana artifact is
`observability/grafana/provisioning/dashboards/bidding-runtime-overview.json`.

Regenerate after an intentional metric or dashboard change:

```sh
yarn observability:bidding-dashboard:generate
```

Verify that the committed dashboard is current without writing it:

```sh
yarn observability:bidding-dashboard:check
```

Run the dashboard vocabulary checks and the pinned Prometheus query tests:

```sh
yarn observability:bidding-dashboard:test
yarn observability:bidding-dashboard:test-promql <promtool-path> <project-artifact-directory>
```

Use `promtool` from the Prometheus version pinned in `docker-compose.yml`.
The query test requires both arguments, saves its synthetic scrape fixture in
the chosen project directory, evaluates every generated query, and verifies
30-minute, multi-hour, and overflowing observations with independent chain
selectors. It needs no live bot, marketplace, or database.

Do not hand-edit the generated JSON. Update the generator and metric owner
contracts together, regenerate, and review the resulting PromQL and panel
reading order.

## Recovery Checklist

If every bidding panel is empty:

1. Confirm the Admin toggle was saved and the bidding bot was restarted after
   the save.
2. Check `/healthz`, then `/metrics`, then the Prometheus `up` query in that
   order.
3. Read the `trading-bidding-bot` log. A metrics-endpoint warning means the bot
   deliberately continued without metrics; free the configured port and
   restart it. If the Admin port was intentionally changed, also update and
   restart Prometheus as described above.
4. If the endpoint works but Prometheus is down, confirm the repository
   observability stack is running and that the `artgod-trading` target matches
   the configured loopback port.
5. If only one metric family is empty, perform the corresponding action during
   the selected dashboard time range. Some series do not exist until that work
   occurs.

Keep the endpoint on loopback. Do not solve a scrape problem by exposing the
installed desktop listener to a LAN or public interface.
