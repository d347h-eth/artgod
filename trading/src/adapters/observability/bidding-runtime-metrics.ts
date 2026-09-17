import type {
    Metrics,
    MetricLabels,
} from "@artgod/shared/observability/metrics";
import {
    BIDDER_TARGET_TYPE,
    type BidderJob,
} from "../../domain/market/strategy/job.js";
import type {
    BidderMarketAction,
    BidderObservabilityPort,
    BidderRefreshRequestOutcome,
    BidderRefreshTrigger,
    BidderScanResult,
} from "../../application/use-cases/bidding/bidder.js";
import type {
    BiddingCommandObservabilityPort,
    BiddingCommandReconciliationResult,
    BiddingCommandTrigger,
} from "../../application/use-cases/bidding/bidding-job-command-reconciler.js";
import type { BiddingJobCommand } from "../../application/use-cases/bidding/bidding-job-command-repository.js";
import type {
    BiddingBidBookProjectionObservabilityPort,
    BiddingBidBookProjectionRequestOutcome,
} from "../../application/use-cases/bidding/bidding-bid-book-projection.js";
import type {
    CollectionOfferRefreshOutcome,
    CollectionOfferSnapshotRefreshResult,
    CollectionOfferSnapshotObserver,
} from "../../application/use-cases/bidding/collection-offer-snapshot-service.js";
import type {
    HotRefreshBackpressureObservabilityPort,
    HotRefreshLaneKind,
    HotRefreshSignalOutcome,
} from "../../application/use-cases/market/pipeline/lib/hot-refresh-backpressure.js";
import type { Type } from "../../domain/market/event.js";
import type {
    OpenSeaEventStreamObservabilityPort,
    OpenSeaStreamEventOutcome,
} from "../opensea/open-sea-event-stream.js";
import {
    TOKEN_BUCKET_RATE_LIMIT_PRIORITY,
    TOKEN_BUCKET_RATE_LIMIT_PRIORITY_LABEL,
    type TokenBucketRateLimitPriority,
    type TokenBucketRateLimiterObservabilityPort,
} from "../support/token-bucket-rate-limiter.js";
import type { Scope } from "../../domain/market/event.js";
import { observeBestEffort } from "../../utils/observe-best-effort.js";
import {
    BIDDING_RUNTIME_CONFIGURATION_SETTING,
    BIDDING_RUNTIME_METRIC_LABEL,
    BIDDING_RUNTIME_METRIC_NAME,
    BIDDING_RUNTIME_HISTOGRAM_BUCKETS,
    BIDDING_RUNTIME_METRIC_RESULT,
    BIDDING_RUNTIME_METRIC_STATE,
    BIDDING_RUNTIME_TARGET_TYPE_AGGREGATE,
    BIDDING_RUNTIME_UNKNOWN_LABEL,
    type BiddingOpenSeaLane,
    type BiddingRuntimeMetricState,
} from "./bidding-runtime-metric-contract.js";

export type BiddingRuntimeConfigurationInput = {
    maxConcurrentJobs: number;
    scanIntervalMs: number;
    commandPollMs: number;
    commandBatchSize: number;
    snapshotPollMs: number;
    snapshotTtlMs: number;
    hotRefreshBroadCooldownMs: number;
    hotRefreshBroadMaxPending: number;
    hotRefreshItemCooldownMs: number;
    hotRefreshItemMaxPending: number;
};

export type OpenSeaOperationMetricsObserver = {
    onOpenSeaOperationFinished(input: {
        operation: string;
        priority: TokenBucketRateLimitPriority;
        durationMs: number;
        succeeded: boolean;
        expectedAbsence?: boolean;
    }): void;
    onOpenSeaRetry(input: {
        operation: string;
        priority: TokenBucketRateLimitPriority;
    }): void;
};

type BootstrapPhaseObservation = {
    phase: string;
    durationMs: number;
    succeeded: boolean;
};

// BiddingRuntimeMetrics adapts typed runtime observations into low-cardinality Prometheus series.
export class BiddingRuntimeMetrics
    implements
        BidderObservabilityPort,
        BiddingCommandObservabilityPort,
        HotRefreshBackpressureObservabilityPort,
        OpenSeaEventStreamObservabilityPort,
        CollectionOfferSnapshotObserver,
        BiddingBidBookProjectionObservabilityPort
{
    private activeStreamDispatches = 0;
    private readonly metrics: Metrics;

    constructor(metrics: Metrics) {
        this.metrics = createBestEffortMetrics(metrics);
        this.reportActiveStreamDispatches();
    }

    public createOpenSeaOperationObserver(
        lane: BiddingOpenSeaLane,
    ): OpenSeaOperationMetricsObserver {
        return {
            onOpenSeaOperationFinished: (input) => {
                const labels = {
                    [BIDDING_RUNTIME_METRIC_LABEL.Lane]: lane,
                    [BIDDING_RUNTIME_METRIC_LABEL.Operation]: input.operation,
                    [BIDDING_RUNTIME_METRIC_LABEL.Priority]:
                        rateLimitPriorityLabel(input.priority),
                    [BIDDING_RUNTIME_METRIC_LABEL.Result]: input.expectedAbsence
                        ? BIDDING_RUNTIME_METRIC_RESULT.ExpectedAbsence
                        : toResult(input.succeeded),
                };
                this.metrics.increment(
                    BIDDING_RUNTIME_METRIC_NAME.OpenSeaOperations,
                    1,
                    labels,
                );
                this.observeHistogram(
                    BIDDING_RUNTIME_METRIC_NAME.OpenSeaOperationDuration,
                    input.durationMs,
                    labels,
                );
            },
            onOpenSeaRetry: (input) => {
                this.metrics.increment(
                    BIDDING_RUNTIME_METRIC_NAME.OpenSeaRetries,
                    1,
                    {
                        [BIDDING_RUNTIME_METRIC_LABEL.Lane]: lane,
                        [BIDDING_RUNTIME_METRIC_LABEL.Operation]:
                            input.operation,
                        [BIDDING_RUNTIME_METRIC_LABEL.Priority]:
                            rateLimitPriorityLabel(input.priority),
                    },
                );
            },
        };
    }

    public createRateLimiterObserver(
        lane: BiddingOpenSeaLane,
    ): TokenBucketRateLimiterObservabilityPort {
        return {
            onRateLimitQueueDepthChanged: (count) => {
                this.metrics.gauge(
                    BIDDING_RUNTIME_METRIC_NAME.OpenSeaRateLimitQueueDepth,
                    count,
                    { [BIDDING_RUNTIME_METRIC_LABEL.Lane]: lane },
                );
            },
            onRateLimitWaitFinished: (input) => {
                this.observeHistogram(
                    BIDDING_RUNTIME_METRIC_NAME.OpenSeaRateLimitWait,
                    input.waitMs,
                    {
                        [BIDDING_RUNTIME_METRIC_LABEL.Lane]: lane,
                        [BIDDING_RUNTIME_METRIC_LABEL.Priority]:
                            rateLimitPriorityLabel(input.priority),
                        [BIDDING_RUNTIME_METRIC_LABEL.Outcome]: input.outcome,
                    },
                );
            },
        };
    }

    public setRuntimeState(state: BiddingRuntimeMetricState): void {
        for (const candidate of Object.values(BIDDING_RUNTIME_METRIC_STATE)) {
            this.metrics.gauge(
                BIDDING_RUNTIME_METRIC_NAME.RuntimeState,
                candidate === state ? 1 : 0,
                {
                    [BIDDING_RUNTIME_METRIC_LABEL.RuntimeState]: candidate,
                },
            );
        }
    }

    public observeBootstrapPhase(input: BootstrapPhaseObservation): void {
        this.observeHistogram(
            BIDDING_RUNTIME_METRIC_NAME.RuntimeBootstrapPhaseDuration,
            input.durationMs,
            {
                [BIDDING_RUNTIME_METRIC_LABEL.Phase]: input.phase,
                [BIDDING_RUNTIME_METRIC_LABEL.Result]: toResult(
                    input.succeeded,
                ),
            },
        );
    }

    public observeTimeToReady(durationMs: number): void {
        this.observeHistogram(
            BIDDING_RUNTIME_METRIC_NAME.RuntimeTimeToReady,
            durationMs,
            undefined,
        );
    }

    public recordConfiguration(input: BiddingRuntimeConfigurationInput): void {
        const values = {
            [BIDDING_RUNTIME_CONFIGURATION_SETTING.MaxConcurrentJobs]:
                input.maxConcurrentJobs,
            [BIDDING_RUNTIME_CONFIGURATION_SETTING.ScanIntervalMs]:
                input.scanIntervalMs,
            [BIDDING_RUNTIME_CONFIGURATION_SETTING.CommandPollMs]:
                input.commandPollMs,
            [BIDDING_RUNTIME_CONFIGURATION_SETTING.CommandBatchSize]:
                input.commandBatchSize,
            [BIDDING_RUNTIME_CONFIGURATION_SETTING.SnapshotPollMs]:
                input.snapshotPollMs,
            [BIDDING_RUNTIME_CONFIGURATION_SETTING.SnapshotTtlMs]:
                input.snapshotTtlMs,
            [BIDDING_RUNTIME_CONFIGURATION_SETTING.HotRefreshBroadCooldownMs]:
                input.hotRefreshBroadCooldownMs,
            [BIDDING_RUNTIME_CONFIGURATION_SETTING.HotRefreshBroadMaxPending]:
                input.hotRefreshBroadMaxPending,
            [BIDDING_RUNTIME_CONFIGURATION_SETTING.HotRefreshItemCooldownMs]:
                input.hotRefreshItemCooldownMs,
            [BIDDING_RUNTIME_CONFIGURATION_SETTING.HotRefreshItemMaxPending]:
                input.hotRefreshItemMaxPending,
        };
        for (const [setting, value] of Object.entries(values)) {
            this.metrics.gauge(
                BIDDING_RUNTIME_METRIC_NAME.RuntimeConfiguration,
                value,
                { [BIDDING_RUNTIME_METRIC_LABEL.Setting]: setting },
            );
        }
    }

    public onJobInventoryChanged(input: {
        total: number;
        targetCounts: Record<BidderJob["target"]["type"], number>;
    }): void {
        this.metrics.gauge(BIDDING_RUNTIME_METRIC_NAME.Jobs, input.total, {
            [BIDDING_RUNTIME_METRIC_LABEL.TargetType]:
                BIDDING_RUNTIME_TARGET_TYPE_AGGREGATE,
        });
        for (const targetType of Object.values(BIDDER_TARGET_TYPE)) {
            this.metrics.gauge(
                BIDDING_RUNTIME_METRIC_NAME.Jobs,
                input.targetCounts[targetType],
                { [BIDDING_RUNTIME_METRIC_LABEL.TargetType]: targetType },
            );
        }
    }

    public onScanFinished(input: {
        durationMs: number;
        jobCount: number;
        result: BidderScanResult;
    }): void {
        const labels = {
            [BIDDING_RUNTIME_METRIC_LABEL.Result]: input.result,
        };
        this.observeHistogram(
            BIDDING_RUNTIME_METRIC_NAME.JobScanDuration,
            input.durationMs,
            labels,
        );
        this.metrics.gauge(
            BIDDING_RUNTIME_METRIC_NAME.JobScanSize,
            input.jobCount,
        );
    }

    public onRefreshRequested(input: {
        trigger: BidderRefreshTrigger;
        targetType: BidderJob["target"]["type"] | null;
        outcome: BidderRefreshRequestOutcome;
    }): void {
        this.metrics.increment(
            BIDDING_RUNTIME_METRIC_NAME.JobRefreshRequests,
            1,
            {
                [BIDDING_RUNTIME_METRIC_LABEL.Trigger]: input.trigger,
                [BIDDING_RUNTIME_METRIC_LABEL.TargetType]:
                    input.targetType ?? BIDDING_RUNTIME_UNKNOWN_LABEL,
                [BIDDING_RUNTIME_METRIC_LABEL.Outcome]: input.outcome,
            },
        );
    }

    public onRefreshStarted(input: {
        trigger: BidderRefreshTrigger;
        targetType: BidderJob["target"]["type"];
        queueWaitMs: number;
    }): void {
        this.observeHistogram(
            BIDDING_RUNTIME_METRIC_NAME.JobRefreshQueueWait,
            input.queueWaitMs,
            {
                [BIDDING_RUNTIME_METRIC_LABEL.Trigger]: input.trigger,
                [BIDDING_RUNTIME_METRIC_LABEL.TargetType]: input.targetType,
            },
        );
    }

    public onRefreshFinished(input: {
        trigger: BidderRefreshTrigger;
        targetType: BidderJob["target"]["type"];
        durationMs: number;
        succeeded: boolean;
    }): void {
        this.observeHistogram(
            BIDDING_RUNTIME_METRIC_NAME.JobRefreshDuration,
            input.durationMs,
            {
                [BIDDING_RUNTIME_METRIC_LABEL.Trigger]: input.trigger,
                [BIDDING_RUNTIME_METRIC_LABEL.TargetType]: input.targetType,
                [BIDDING_RUNTIME_METRIC_LABEL.Result]: toResult(
                    input.succeeded,
                ),
            },
        );
    }

    public onRefreshPressureChanged(input: {
        active: number;
        waiting: number;
        pending: number;
    }): void {
        this.metrics.gauge(
            BIDDING_RUNTIME_METRIC_NAME.JobRefreshActive,
            input.active,
        );
        this.metrics.gauge(
            BIDDING_RUNTIME_METRIC_NAME.JobRefreshWaiting,
            input.waiting,
        );
        this.metrics.gauge(
            BIDDING_RUNTIME_METRIC_NAME.JobRefreshPending,
            input.pending,
        );
    }

    public onMarketActionFinished(input: {
        action: BidderMarketAction;
        targetType: BidderJob["target"]["type"];
        dryRun: boolean;
        durationMs: number;
        succeeded: boolean;
    }): void {
        const labels = {
            [BIDDING_RUNTIME_METRIC_LABEL.Action]: input.action,
            [BIDDING_RUNTIME_METRIC_LABEL.TargetType]: input.targetType,
            [BIDDING_RUNTIME_METRIC_LABEL.DryRun]: String(input.dryRun),
            [BIDDING_RUNTIME_METRIC_LABEL.Result]: toResult(input.succeeded),
        };
        this.metrics.increment(
            BIDDING_RUNTIME_METRIC_NAME.MarketActions,
            1,
            labels,
        );
        this.observeHistogram(
            BIDDING_RUNTIME_METRIC_NAME.MarketActionDuration,
            input.durationMs,
            labels,
        );
    }

    public onReconciliationFinished(input: {
        trigger: BiddingCommandTrigger;
        processed: number;
        durationMs: number;
        result: BiddingCommandReconciliationResult;
    }): void {
        const labels = {
            [BIDDING_RUNTIME_METRIC_LABEL.Trigger]: input.trigger,
            [BIDDING_RUNTIME_METRIC_LABEL.Result]: input.result,
        };
        this.observeHistogram(
            BIDDING_RUNTIME_METRIC_NAME.CommandReconciliationDuration,
            input.durationMs,
            labels,
        );
        this.observeHistogram(
            BIDDING_RUNTIME_METRIC_NAME.CommandReconciliationBatchSize,
            input.processed,
            labels,
        );
    }

    public onCommandClaimed(input: {
        trigger: BiddingCommandTrigger;
        commandKind: BiddingJobCommand["commandKind"];
        queueWaitMs: number;
    }): void {
        this.observeHistogram(
            BIDDING_RUNTIME_METRIC_NAME.CommandQueueWait,
            input.queueWaitMs,
            commandLabels(input),
        );
    }

    public onCommandStrategyStarted(input: {
        trigger: BiddingCommandTrigger;
        commandKind: BiddingJobCommand["commandKind"];
        claimToStrategyMs: number;
        createdToStrategyMs: number;
    }): void {
        const labels = commandLabels(input);
        this.observeHistogram(
            BIDDING_RUNTIME_METRIC_NAME.CommandClaimToStrategy,
            input.claimToStrategyMs,
            labels,
        );
        this.observeHistogram(
            BIDDING_RUNTIME_METRIC_NAME.CommandCreatedToStrategy,
            input.createdToStrategyMs,
            labels,
        );
    }

    // Each observation is one processing attempt, including failures scheduled for retry.
    public onCommandFinished(input: {
        trigger: BiddingCommandTrigger;
        commandKind: BiddingJobCommand["commandKind"];
        durationMs: number;
        succeeded: boolean;
    }): void {
        const labels = {
            ...commandLabels(input),
            [BIDDING_RUNTIME_METRIC_LABEL.Result]: toResult(input.succeeded),
        };
        this.metrics.increment(
            BIDDING_RUNTIME_METRIC_NAME.CommandAttempts,
            1,
            labels,
        );
        this.observeHistogram(
            BIDDING_RUNTIME_METRIC_NAME.CommandProcessingDuration,
            input.durationMs,
            labels,
        );
    }

    private observeHistogram(
        name: keyof typeof BIDDING_RUNTIME_HISTOGRAM_BUCKETS,
        value: number,
        labels?: MetricLabels,
    ): void {
        // The exporter and dashboard share one range so overflow cannot masquerade as a finite p95.
        this.metrics.histogram(name, value, labels, {
            buckets: BIDDING_RUNTIME_HISTOGRAM_BUCKETS[name],
        });
    }

    public onCommandInFlightChanged(count: number): void {
        this.metrics.gauge(BIDDING_RUNTIME_METRIC_NAME.CommandInFlight, count);
    }

    public onSignal(input: {
        laneKind: HotRefreshLaneKind;
        eventType: Type;
        outcome: HotRefreshSignalOutcome;
    }): void {
        this.metrics.increment(
            BIDDING_RUNTIME_METRIC_NAME.HotRefreshSignals,
            1,
            {
                [BIDDING_RUNTIME_METRIC_LABEL.Lane]: input.laneKind,
                [BIDDING_RUNTIME_METRIC_LABEL.EventType]: input.eventType,
                [BIDDING_RUNTIME_METRIC_LABEL.Outcome]: input.outcome,
            },
        );
    }

    public onStateChanged(input: {
        laneKind: HotRefreshLaneKind;
        activeLanes: number;
        knownLanes: number;
        pendingEvents: number;
        pendingSignals: number;
    }): void {
        const labels = {
            [BIDDING_RUNTIME_METRIC_LABEL.Lane]: input.laneKind,
        };
        this.metrics.gauge(
            BIDDING_RUNTIME_METRIC_NAME.HotRefreshActiveLanes,
            input.activeLanes,
            labels,
        );
        this.metrics.gauge(
            BIDDING_RUNTIME_METRIC_NAME.HotRefreshKnownLanes,
            input.knownLanes,
            labels,
        );
        this.metrics.gauge(
            BIDDING_RUNTIME_METRIC_NAME.HotRefreshPendingEvents,
            input.pendingEvents,
            labels,
        );
        this.metrics.gauge(
            BIDDING_RUNTIME_METRIC_NAME.HotRefreshPendingSignals,
            input.pendingSignals,
            labels,
        );
    }

    public onPassFinished(input: {
        laneKind: HotRefreshLaneKind;
        durationMs: number;
        queueWaitMs: number;
        eventCount: number;
        signalCount: number;
        succeeded: boolean;
    }): void {
        const labels = {
            [BIDDING_RUNTIME_METRIC_LABEL.Lane]: input.laneKind,
            [BIDDING_RUNTIME_METRIC_LABEL.Result]: toResult(input.succeeded),
        };
        this.observeHistogram(
            BIDDING_RUNTIME_METRIC_NAME.HotRefreshQueueWait,
            input.queueWaitMs,
            labels,
        );
        this.observeHistogram(
            BIDDING_RUNTIME_METRIC_NAME.HotRefreshPassDuration,
            input.durationMs,
            labels,
        );
        this.observeHistogram(
            BIDDING_RUNTIME_METRIC_NAME.HotRefreshPassEvents,
            input.eventCount,
            labels,
        );
        this.observeHistogram(
            BIDDING_RUNTIME_METRIC_NAME.HotRefreshPassSignals,
            input.signalCount,
            labels,
        );
    }

    public onStreamEvent(input: {
        eventType: Type | null;
        eventScope: Scope | null;
        outcome: OpenSeaStreamEventOutcome;
        ageMs?: number;
    }): void {
        const labels = {
            [BIDDING_RUNTIME_METRIC_LABEL.EventType]:
                input.eventType ?? BIDDING_RUNTIME_UNKNOWN_LABEL,
            [BIDDING_RUNTIME_METRIC_LABEL.EventScope]:
                input.eventScope ?? BIDDING_RUNTIME_UNKNOWN_LABEL,
            [BIDDING_RUNTIME_METRIC_LABEL.Outcome]: input.outcome,
        };
        this.metrics.increment(
            BIDDING_RUNTIME_METRIC_NAME.StreamEvents,
            1,
            labels,
        );
        if (input.ageMs !== undefined) {
            this.observeHistogram(
                BIDDING_RUNTIME_METRIC_NAME.StreamEventAge,
                input.ageMs,
                {
                    [BIDDING_RUNTIME_METRIC_LABEL.EventType]: input.eventType!,
                    [BIDDING_RUNTIME_METRIC_LABEL.EventScope]:
                        input.eventScope!,
                },
            );
        }
    }

    public onStreamDispatchFinished(input: {
        eventType: Type;
        eventScope: Scope;
        durationMs: number;
        succeeded: boolean;
    }): void {
        this.activeStreamDispatches = Math.max(
            0,
            this.activeStreamDispatches - 1,
        );
        this.reportActiveStreamDispatches();
        this.observeHistogram(
            BIDDING_RUNTIME_METRIC_NAME.StreamDispatchDuration,
            input.durationMs,
            {
                [BIDDING_RUNTIME_METRIC_LABEL.EventType]: input.eventType,
                [BIDDING_RUNTIME_METRIC_LABEL.EventScope]: input.eventScope,
                [BIDDING_RUNTIME_METRIC_LABEL.Result]: toResult(
                    input.succeeded,
                ),
            },
        );
    }

    public onStreamDispatchStarted(): void {
        this.activeStreamDispatches += 1;
        this.reportActiveStreamDispatches();
    }

    private reportActiveStreamDispatches(): void {
        this.metrics.gauge(
            BIDDING_RUNTIME_METRIC_NAME.StreamDispatchActive,
            this.activeStreamDispatches,
        );
    }

    public onSnapshotRefreshRequest(input: {
        outcome: CollectionOfferRefreshOutcome;
    }): void {
        this.metrics.increment(
            BIDDING_RUNTIME_METRIC_NAME.SnapshotRefreshRequests,
            1,
            {
                [BIDDING_RUNTIME_METRIC_LABEL.Outcome]: input.outcome,
            },
        );
    }

    public onSnapshotRefreshFinished(input: {
        durationMs: number;
        pageCount: number;
        offerCount: number;
        result: CollectionOfferSnapshotRefreshResult;
    }): void {
        const labels = {
            [BIDDING_RUNTIME_METRIC_LABEL.Result]: input.result,
        };
        this.observeHistogram(
            BIDDING_RUNTIME_METRIC_NAME.SnapshotRefreshDuration,
            input.durationMs,
            labels,
        );
        this.observeHistogram(
            BIDDING_RUNTIME_METRIC_NAME.SnapshotRefreshPages,
            input.pageCount,
            labels,
        );
        this.observeHistogram(
            BIDDING_RUNTIME_METRIC_NAME.SnapshotRefreshOffers,
            input.offerCount,
            labels,
        );
    }

    public onSnapshotStateChanged(input: {
        watchedCollections: number;
        inFlightRefreshes: number;
        pendingRefreshes: number;
    }): void {
        this.metrics.gauge(
            BIDDING_RUNTIME_METRIC_NAME.SnapshotWatchedCollections,
            input.watchedCollections,
        );
        this.metrics.gauge(
            BIDDING_RUNTIME_METRIC_NAME.SnapshotRefreshInFlight,
            input.inFlightRefreshes,
        );
        this.metrics.gauge(
            BIDDING_RUNTIME_METRIC_NAME.SnapshotRefreshPending,
            input.pendingRefreshes,
        );
    }

    public onProjectionRequested(input: {
        outcome: BiddingBidBookProjectionRequestOutcome;
    }): void {
        this.metrics.increment(
            BIDDING_RUNTIME_METRIC_NAME.BidBookProjectionRequests,
            1,
            {
                [BIDDING_RUNTIME_METRIC_LABEL.Outcome]: input.outcome,
            },
        );
    }

    public onProjectionFinished(input: {
        queueWaitMs: number;
        durationMs: number;
        rowCount: number;
        succeeded: boolean;
    }): void {
        const labels = {
            [BIDDING_RUNTIME_METRIC_LABEL.Result]: toResult(input.succeeded),
        };
        this.observeHistogram(
            BIDDING_RUNTIME_METRIC_NAME.BidBookProjectionQueueWait,
            input.queueWaitMs,
            labels,
        );
        this.observeHistogram(
            BIDDING_RUNTIME_METRIC_NAME.BidBookProjectionDuration,
            input.durationMs,
            labels,
        );
        this.observeHistogram(
            BIDDING_RUNTIME_METRIC_NAME.BidBookProjectionRows,
            input.rowCount,
            labels,
        );
    }

    public onProjectionStateChanged(input: {
        active: number;
        pending: number;
    }): void {
        this.metrics.gauge(
            BIDDING_RUNTIME_METRIC_NAME.BidBookProjectionActive,
            input.active,
        );
        this.metrics.gauge(
            BIDDING_RUNTIME_METRIC_NAME.BidBookProjectionPending,
            input.pending,
        );
    }
}

function createBestEffortMetrics(metrics: Metrics): Metrics {
    return {
        increment(name, value, labels) {
            observeBestEffort(() => metrics.increment(name, value, labels));
        },
        gauge(name, value, labels) {
            observeBestEffort(() => metrics.gauge(name, value, labels));
        },
        histogram(name, value, labels, options) {
            observeBestEffort(() =>
                metrics.histogram(name, value, labels, options),
            );
        },
    };
}

function toResult(
    succeeded: boolean,
): (typeof BIDDING_RUNTIME_METRIC_RESULT)[keyof typeof BIDDING_RUNTIME_METRIC_RESULT] {
    return succeeded
        ? BIDDING_RUNTIME_METRIC_RESULT.Success
        : BIDDING_RUNTIME_METRIC_RESULT.Failure;
}

function commandLabels(input: {
    trigger: BiddingCommandTrigger;
    commandKind: BiddingJobCommand["commandKind"];
}): Record<string, string> {
    return {
        [BIDDING_RUNTIME_METRIC_LABEL.Trigger]: input.trigger,
        [BIDDING_RUNTIME_METRIC_LABEL.CommandKind]: input.commandKind,
    };
}

function rateLimitPriorityLabel(
    priority: TokenBucketRateLimitPriority,
): (typeof TOKEN_BUCKET_RATE_LIMIT_PRIORITY_LABEL)[keyof typeof TOKEN_BUCKET_RATE_LIMIT_PRIORITY_LABEL] {
    return priority === TOKEN_BUCKET_RATE_LIMIT_PRIORITY.UserCommand
        ? TOKEN_BUCKET_RATE_LIMIT_PRIORITY_LABEL.UserCommand
        : TOKEN_BUCKET_RATE_LIMIT_PRIORITY_LABEL.Background;
}
