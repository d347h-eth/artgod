import { createPrometheusMetrics } from "../../shared/observability/metrics/index.js";
import { RUNTIME_METRIC_DEFAULT_LABEL } from "../../shared/observability/metrics/runtime.js";
import {
    TRADING_BIDDING_JOB_RUNTIME_CONSTRAINT,
    TRADING_JOB_COMMAND_KIND,
} from "../../shared/types/index.js";
import { BiddingRuntimeMetrics } from "../../trading/src/adapters/observability/bidding-runtime-metrics.js";
import {
    BIDDING_OPEN_SEA_LANE,
    BIDDING_RUNTIME_METRIC_STATE,
} from "../../trading/src/adapters/observability/bidding-runtime-metric-contract.js";
import {
    BIDDER_DECISION,
    BIDDER_MARKET_ACTION,
    BIDDER_OBSERVED_POSITION,
    BIDDER_SCAN_RESULT,
} from "../../trading/src/application/use-cases/bidding/bidder.js";
import { BIDDER_TARGET_TYPE } from "../../trading/src/domain/market/strategy/job.js";
import {
    BIDDING_COMMAND_DURABLE_OUTCOME,
    BIDDING_COMMAND_RECONCILIATION_RESULT,
    BIDDING_COMMAND_TRIGGER,
} from "../../trading/src/application/use-cases/bidding/bidding-job-command-reconciler.js";
import { BIDDING_COMMAND_QUEUE_STATUS } from "../../trading/src/application/use-cases/bidding/bidding-command-queue-health.js";
import { BIDDING_WORK_STAGE } from "../../trading/src/application/use-cases/bidding/bidding-work-observability.js";
import { BIDDING_HEALTH_COMPONENT } from "../../trading/src/application/use-cases/bidding/sample-bidding-runtime-health.js";
import { COLLECTION_OFFER_FRESHNESS } from "../../trading/src/application/use-cases/bidding/collection-offer-snapshot-service.js";
import { OPEN_SEA_SNAPSHOT_OPERATION } from "../../trading/src/adapters/opensea/open-sea-collection-offer-source.js";
import { TOKEN_BUCKET_RATE_LIMIT_PRIORITY } from "../../trading/src/adapters/support/token-bucket-rate-limiter.js";
import {
    TRADING_METRICS_PREFIX,
    TRADING_METRICS_WORKER,
} from "../../trading/src/runtime/observability.js";

const zeros = <T extends string>(
    values: Record<string, T>,
): Record<T, number> =>
    Object.fromEntries(
        Object.values(values).map((value) => [value, 0]),
    ) as Record<T, number>;

// These fixtures are emitted by the actual adapter/exporter, not manually invented metric series.
// Their synthetic clock is relative to promtool's evaluation origin; no live runtime is involved.
export async function biddingRuntimePromqlFixture(chainId: string) {
    let now = 60_000;
    const metrics = await createPrometheusMetrics({
        prefix: TRADING_METRICS_PREFIX,
        defaultLabels: {
            [RUNTIME_METRIC_DEFAULT_LABEL.Worker]:
                TRADING_METRICS_WORKER.BiddingBot,
            [RUNTIME_METRIC_DEFAULT_LABEL.ChainId]: chainId,
        },
        collectProcessMetrics: false,
    });
    if (!metrics)
        throw new Error(
            "The existing prom-client dependency is required for query tests",
        );
    const observer = new BiddingRuntimeMetrics(metrics, () => now);
    observer.setRuntimeState(BIDDING_RUNTIME_METRIC_STATE.Running);
    observer.onScanFinished({
        durationMs: 100,
        jobCount: 3,
        result: BIDDER_SCAN_RESULT.CompletedWithFailures,
    });
    observer.onScanFinished({
        durationMs: 100,
        jobCount: 3,
        result: BIDDER_SCAN_RESULT.Failure,
    });
    for (const result of [
        BIDDING_COMMAND_RECONCILIATION_RESULT.CompletedWithFailures,
        BIDDING_COMMAND_RECONCILIATION_RESULT.Failure,
    ]) {
        observer.onReconciliationFinished({
            trigger: BIDDING_COMMAND_TRIGGER.Poll,
            processed: 1,
            durationMs: 100,
            result,
        });
    }
    observer.onScanProgress({
        active: true,
        total: 3,
        completed: 1,
        startedAtMs: now,
        lastProgressAtMs: 90_000,
    });
    const finishWork = observer.onWorkStarted(BIDDING_WORK_STAGE.MarketRead);
    const finishApi = observer
        .createOpenSeaOperationObserver(BIDDING_OPEN_SEA_LANE.Snapshot)
        .onOpenSeaOperationStarted({
            operation: OPEN_SEA_SNAPSHOT_OPERATION.GetAllOffersPage,
            priority: TOKEN_BUCKET_RATE_LIMIT_PRIORITY.Background,
        });
    observer.onCommandQueueHealth({
        counts: {
            [BIDDING_COMMAND_QUEUE_STATUS.Pending]: 2,
            [BIDDING_COMMAND_QUEUE_STATUS.Retrying]: 1,
            [BIDDING_COMMAND_QUEUE_STATUS.Processing]: 1,
            [BIDDING_COMMAND_QUEUE_STATUS.FailedTerminal]: 1,
        },
        oldestPendingAtMs: 30_000,
        staleProcessing: 1,
    });
    for (const outcome of Object.values(BIDDING_COMMAND_DURABLE_OUTCOME))
        observer.onCommandDurableOutcome({
            commandKind: TRADING_JOB_COMMAND_KIND.JobUpdated,
            outcome,
        });
    observer.onSnapshotFreshness({
        counts: {
            [COLLECTION_OFFER_FRESHNESS.Fresh]: 1,
            [COLLECTION_OFFER_FRESHNESS.Stale]: 2,
            [COLLECTION_OFFER_FRESHNESS.Missing]: 1,
        },
        backoffCollections: 1,
        oldestCompleteAtMs: 50_000,
    });
    observer.onPublicationHealth({
        watchedCollections: 4,
        missingCollections: 2,
        laggingCollections: 1,
        oldestPublishedAtMs: 80_000,
        oldestPublishedSnapshotAtMs: 50_000,
    });
    for (const decision of Object.values(BIDDER_DECISION))
        for (const dryRun of [false, true])
            observer.onDecision({
                decision,
                dryRun,
                targetType: BIDDER_TARGET_TYPE.Token,
            });
    for (const action of Object.values(BIDDER_MARKET_ACTION))
        for (const dryRun of [false, true])
            for (const succeeded of [false, true])
                observer.onMarketActionFinished({
                    action,
                    dryRun,
                    succeeded,
                    durationMs: 10,
                    targetType: BIDDER_TARGET_TYPE.Token,
                });
    const positions = zeros(BIDDER_OBSERVED_POSITION);
    positions[BIDDER_OBSERVED_POSITION.Unobserved] = 1;
    positions[BIDDER_OBSERVED_POSITION.Losing] = 2;
    const constraints = zeros(TRADING_BIDDING_JOB_RUNTIME_CONSTRAINT);
    constraints[TRADING_BIDDING_JOB_RUNTIME_CONSTRAINT.Ceiling] = 2;
    observer.onPositionHealth({ positions, constraints });
    for (const component of Object.values(BIDDING_HEALTH_COMPONENT))
        observer.onHealthSample({
            component,
            succeeded: true,
            sampledAtMs: 120_000,
        });
    observer.onHealthSample({
        component: BIDDING_HEALTH_COMPONENT.CommandQueue,
        succeeded: false,
        sampledAtMs: 180_000,
    });
    const held = await metrics.metricsText();
    now = 240_000;
    finishWork(true);
    finishApi(false);
    observer.onScanProgress({
        active: false,
        total: 3,
        completed: 3,
        startedAtMs: 60_000,
        lastProgressAtMs: now,
    });
    observer.onScanFinished({
        durationMs: 180_000,
        jobCount: 3,
        result: BIDDER_SCAN_RESULT.Success,
    });
    observer.onCommandQueueHealth({
        counts: zeros(BIDDING_COMMAND_QUEUE_STATUS),
        oldestPendingAtMs: null,
        staleProcessing: 0,
    });
    observer.onSnapshotFreshness({
        counts: zeros(COLLECTION_OFFER_FRESHNESS),
        backoffCollections: 0,
        oldestCompleteAtMs: null,
    });
    observer.onPublicationHealth({
        watchedCollections: 0,
        missingCollections: 0,
        laggingCollections: 0,
        oldestPublishedAtMs: null,
        oldestPublishedSnapshotAtMs: null,
    });
    observer.onPositionHealth({
        positions: zeros(BIDDER_OBSERVED_POSITION),
        constraints: zeros(TRADING_BIDDING_JOB_RUNTIME_CONSTRAINT),
    });
    for (const component of Object.values(BIDDING_HEALTH_COMPONENT))
        observer.onHealthSample({
            component,
            succeeded: true,
            sampledAtMs: now,
        });
    return { held, recovered: await metrics.metricsText() };
}

export function scrapeSeries(scrape: string) {
    return scrape
        .split("\n")
        .filter((line) => line && !line.startsWith("#"))
        .map((line) => {
            const separator = line.lastIndexOf(" ");
            const value = Number(line.slice(separator + 1));
            if (!Number.isFinite(value))
                throw new Error(`Non-finite synthetic metric: ${line}`);
            return {
                series: line.slice(0, separator),
                values: `${value}+0x20`,
            };
        });
}
