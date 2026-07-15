import { describe, expect, it } from "vitest";
import { createPrometheusMetrics } from "@artgod/shared/observability/metrics";
import type { Metrics } from "@artgod/shared/observability/metrics";
import { TRADING_JOB_COMMAND_KIND } from "@artgod/shared/types";
import { BIDDER_TARGET_TYPE } from "../../domain/market/strategy/job.js";
import {
    BIDDER_MARKET_ACTION,
    BIDDER_REFRESH_REQUEST_OUTCOME,
    BIDDER_REFRESH_TRIGGER,
    BIDDER_SCAN_RESULT,
} from "../../application/use-cases/bidding/bidder.js";
import {
    BIDDING_COMMAND_RECONCILIATION_RESULT,
    BIDDING_COMMAND_TRIGGER,
} from "../../application/use-cases/bidding/bidding-job-command-reconciler.js";
import { BIDDING_BID_BOOK_PROJECTION_REQUEST_OUTCOME } from "../../application/use-cases/bidding/bidding-bid-book-projection.js";
import {
    COLLECTION_OFFER_REFRESH_OUTCOME,
    COLLECTION_OFFER_SNAPSHOT_REFRESH_RESULT,
} from "../../application/use-cases/bidding/collection-offer-snapshot-service.js";
import {
    HOT_REFRESH_LANE_KIND,
    HOT_REFRESH_SIGNAL_OUTCOME,
} from "../../application/use-cases/market/pipeline/lib/hot-refresh-backpressure.js";
import { Scope, Type } from "../../domain/market/event.js";
import { OPEN_SEA_BIDDING_OPERATION } from "../opensea/open-sea-bidding-service.js";
import { OPEN_SEA_STREAM_EVENT_OUTCOME } from "../opensea/open-sea-event-stream.js";
import {
    TOKEN_BUCKET_RATE_LIMIT_PRIORITY,
    TOKEN_BUCKET_RATE_LIMIT_WAIT_OUTCOME,
} from "../support/token-bucket-rate-limiter.js";
import { BIDDING_RUNTIME_BOOTSTRAP_PHASE } from "../../runtime/bidding-runtime.js";
import {
    TRADING_METRICS_PREFIX,
    TRADING_METRICS_WORKER,
} from "../../runtime/observability.js";
import {
    BIDDING_COMMAND_QUEUE_DURATION_BUCKETS_MS,
    BIDDING_RUNTIME_FORBIDDEN_HIGH_CARDINALITY_LABELS,
    BIDDING_OPEN_SEA_LANE,
    BIDDING_LONG_DURATION_BUCKETS_MS,
    BIDDING_RUNTIME_METRIC_NAME,
    BIDDING_RUNTIME_METRIC_RESULT,
    BIDDING_RUNTIME_METRIC_STATE,
    BIDDING_RUNTIME_QUEUE_DURATION_BUCKETS_MS,
} from "./bidding-runtime-metric-contract.js";
import { BiddingRuntimeMetrics } from "./bidding-runtime-metrics.js";

const TEST_TARGET_COUNTS = {
    [BIDDER_TARGET_TYPE.Token]: 2,
    [BIDDER_TARGET_TYPE.Collection]: 1,
    [BIDDER_TARGET_TYPE.CompetitiveTrait]: 0,
};

describe("BiddingRuntimeMetrics", () => {
    it("exports lifecycle, pressure, latency, and business metrics with bounded labels", async () => {
        const metrics = await createPrometheusMetrics({
            prefix: TRADING_METRICS_PREFIX,
            defaultLabels: {
                worker: TRADING_METRICS_WORKER.BiddingBot,
                chain_id: "1",
            },
            collectProcessMetrics: false,
        });
        if (!metrics) {
            throw new Error("prom-client is required for this test");
        }
        const observability = new BiddingRuntimeMetrics(metrics);

        observability.setRuntimeState(
            BIDDING_RUNTIME_METRIC_STATE.Bootstrapping,
        );
        observability.observeBootstrapPhase({
            phase: BIDDING_RUNTIME_BOOTSTRAP_PHASE.SnapshotBootstrap,
            durationMs: 115_000,
            succeeded: true,
        });
        observability.observeTimeToReady(120_000);
        observability.recordConfiguration({
            maxConcurrentJobs: 4,
            scanIntervalMs: 30_000,
            commandPollMs: 1_000,
            commandBatchSize: 25,
            snapshotPollMs: 60_000,
            snapshotTtlMs: 60_000,
            hotRefreshBroadCooldownMs: 2_000,
            hotRefreshBroadMaxPending: 100,
            hotRefreshItemCooldownMs: 500,
            hotRefreshItemMaxPending: 500,
        });
        observability.onJobInventoryChanged({
            total: 3,
            targetCounts: TEST_TARGET_COUNTS,
        });
        observability.onScanFinished({
            durationMs: 4_500,
            jobCount: 3,
            result: BIDDER_SCAN_RESULT.CompletedWithFailures,
        });
        observability.onRefreshRequested({
            trigger: BIDDER_REFRESH_TRIGGER.HotStream,
            targetType: BIDDER_TARGET_TYPE.Token,
            outcome: BIDDER_REFRESH_REQUEST_OUTCOME.Coalesced,
        });
        observability.onRefreshStarted({
            trigger: BIDDER_REFRESH_TRIGGER.HotStream,
            targetType: BIDDER_TARGET_TYPE.Token,
            queueWaitMs: 25,
        });
        observability.onRefreshFinished({
            trigger: BIDDER_REFRESH_TRIGGER.HotStream,
            targetType: BIDDER_TARGET_TYPE.Token,
            durationMs: 250,
            succeeded: true,
        });
        observability.onRefreshPressureChanged({
            active: 2,
            waiting: 3,
            pending: 1,
        });
        observability.onMarketActionFinished({
            action: BIDDER_MARKET_ACTION.PlaceOffer,
            targetType: BIDDER_TARGET_TYPE.Token,
            dryRun: false,
            durationMs: 500,
            succeeded: true,
        });
        observability.onCommandClaimed({
            trigger: BIDDING_COMMAND_TRIGGER.Signal,
            commandKind: TRADING_JOB_COMMAND_KIND.JobUpdated,
            queueWaitMs: BIDDING_COMMAND_QUEUE_DURATION_BUCKETS_MS.at(-2)!,
        });
        observability.onCommandStrategyStarted({
            trigger: BIDDING_COMMAND_TRIGGER.Signal,
            commandKind: TRADING_JOB_COMMAND_KIND.JobUpdated,
            claimToStrategyMs: 250,
            createdToStrategyMs:
                BIDDING_COMMAND_QUEUE_DURATION_BUCKETS_MS.at(-2)!,
        });
        observability.onReconciliationFinished({
            trigger: BIDDING_COMMAND_TRIGGER.Signal,
            processed: 1,
            durationMs: 900,
            result: BIDDING_COMMAND_RECONCILIATION_RESULT.CompletedWithFailures,
        });
        observability.onCommandFinished({
            trigger: BIDDING_COMMAND_TRIGGER.Signal,
            commandKind: TRADING_JOB_COMMAND_KIND.JobUpdated,
            durationMs: 900,
            succeeded: true,
        });
        observability.onSignal({
            laneKind: HOT_REFRESH_LANE_KIND.Item,
            eventType: Type.ItemReceivedBid,
            outcome: HOT_REFRESH_SIGNAL_OUTCOME.Coalesced,
        });
        observability.onStateChanged({
            laneKind: HOT_REFRESH_LANE_KIND.Item,
            activeLanes: 8,
            knownLanes: 50,
            pendingEvents: 12,
            pendingSignals: 30,
        });
        observability.onPassFinished({
            laneKind: HOT_REFRESH_LANE_KIND.Item,
            durationMs: 500,
            queueWaitMs: 100,
            eventCount: 4,
            signalCount: 10,
            succeeded: true,
        });
        observability.onStreamEvent({
            eventType: Type.ItemReceivedBid,
            eventScope: Scope.Item,
            outcome: OPEN_SEA_STREAM_EVENT_OUTCOME.Normalized,
            ageMs: 750,
        });
        observability.onStreamDispatchStarted();
        observability.onStreamDispatchStarted();
        observability.onStreamDispatchFinished({
            eventType: Type.ItemReceivedBid,
            eventScope: Scope.Item,
            durationMs: 5,
            succeeded: true,
        });
        observability.onSnapshotRefreshRequest({
            outcome: COLLECTION_OFFER_REFRESH_OUTCOME.JoinedInFlight,
        });
        observability.onSnapshotRefreshFinished({
            durationMs: 115_000,
            pageCount: 30,
            offerCount: 11_800,
            result: COLLECTION_OFFER_SNAPSHOT_REFRESH_RESULT.Partial,
        });
        observability.onSnapshotStateChanged({
            watchedCollections: 2,
            inFlightRefreshes: 1,
            pendingRefreshes: 1,
        });
        observability.onProjectionRequested({
            outcome: BIDDING_BID_BOOK_PROJECTION_REQUEST_OUTCOME.Coalesced,
        });
        observability.onProjectionFinished({
            queueWaitMs: 10,
            durationMs: 150,
            rowCount: 11_800,
            succeeded: true,
        });

        const openSeaObserver = observability.createOpenSeaOperationObserver(
            BIDDING_OPEN_SEA_LANE.Bidding,
        );
        openSeaObserver.onOpenSeaOperationFinished({
            operation: OPEN_SEA_BIDDING_OPERATION.GetNftOffers,
            priority: TOKEN_BUCKET_RATE_LIMIT_PRIORITY.UserCommand,
            durationMs: 350,
            succeeded: true,
        });
        openSeaObserver.onOpenSeaOperationFinished({
            operation: OPEN_SEA_BIDDING_OPERATION.GetBestOffer,
            priority: TOKEN_BUCKET_RATE_LIMIT_PRIORITY.Background,
            durationMs: 25,
            succeeded: true,
            expectedAbsence: true,
        });
        openSeaObserver.onOpenSeaRetry({
            operation: OPEN_SEA_BIDDING_OPERATION.GetNftOffers,
            priority: TOKEN_BUCKET_RATE_LIMIT_PRIORITY.UserCommand,
        });
        const limiterObserver = observability.createRateLimiterObserver(
            BIDDING_OPEN_SEA_LANE.Bidding,
        );
        limiterObserver.onRateLimitQueueDepthChanged(7);
        limiterObserver.onRateLimitWaitFinished({
            priority: TOKEN_BUCKET_RATE_LIMIT_PRIORITY.UserCommand,
            waitMs: 200,
            outcome: TOKEN_BUCKET_RATE_LIMIT_WAIT_OUTCOME.Queued,
        });

        const scrape = await metrics.metricsText();
        expect(scrape).toContain(metric(BIDDING_RUNTIME_METRIC_NAME.Jobs));
        expect(scrape).toContain(
            metric(BIDDING_RUNTIME_METRIC_NAME.CommandClaimToStrategy),
        );
        expect(scrape).toContain(
            metric(BIDDING_RUNTIME_METRIC_NAME.HotRefreshActiveLanes),
        );
        expect(scrape).toMatch(
            new RegExp(
                `${metric(BIDDING_RUNTIME_METRIC_NAME.StreamDispatchActive)}\\{[^\\n]*\\} 1`,
            ),
        );
        expect(scrape).toContain(
            metric(BIDDING_RUNTIME_METRIC_NAME.OpenSeaRateLimitWait),
        );
        expect(scrape).toContain(
            `result="${BIDDING_RUNTIME_METRIC_RESULT.ExpectedAbsence}"`,
        );
        expect(scrape).toContain(
            `${metric(BIDDING_RUNTIME_METRIC_NAME.SnapshotRefreshDuration)}_bucket`,
        );
        expect(scrape).toContain(
            `result="${COLLECTION_OFFER_SNAPSHOT_REFRESH_RESULT.Partial}"`,
        );
        expect(scrape).toContain('le="600000"');
        expect(
            hasHistogramBucket(
                scrape,
                BIDDING_RUNTIME_METRIC_NAME.CommandQueueWait,
                BIDDING_COMMAND_QUEUE_DURATION_BUCKETS_MS.at(-1)!,
            ),
        ).toBe(true);
        expect(
            hasHistogramBucket(
                scrape,
                BIDDING_RUNTIME_METRIC_NAME.CommandCreatedToStrategy,
                BIDDING_COMMAND_QUEUE_DURATION_BUCKETS_MS.at(-1)!,
            ),
        ).toBe(true);
        expect(
            hasHistogramBucket(
                scrape,
                BIDDING_RUNTIME_METRIC_NAME.CommandClaimToStrategy,
                BIDDING_LONG_DURATION_BUCKETS_MS.at(-1)!,
            ),
        ).toBe(true);
        expect(
            hasHistogramBucket(
                scrape,
                BIDDING_RUNTIME_METRIC_NAME.CommandClaimToStrategy,
                BIDDING_COMMAND_QUEUE_DURATION_BUCKETS_MS.at(-1)!,
            ),
        ).toBe(false);
        for (const countMetric of [
            BIDDING_RUNTIME_METRIC_NAME.CommandReconciliationBatchSize,
            BIDDING_RUNTIME_METRIC_NAME.HotRefreshPassEvents,
            BIDDING_RUNTIME_METRIC_NAME.HotRefreshPassSignals,
            BIDDING_RUNTIME_METRIC_NAME.SnapshotRefreshPages,
            BIDDING_RUNTIME_METRIC_NAME.SnapshotRefreshOffers,
            BIDDING_RUNTIME_METRIC_NAME.BidBookProjectionRows,
        ]) {
            expect(hasHistogramBucket(scrape, countMetric, 0)).toBe(true);
        }
        for (const durationMetric of [
            BIDDING_RUNTIME_METRIC_NAME.RuntimeBootstrapPhaseDuration,
            BIDDING_RUNTIME_METRIC_NAME.JobRefreshQueueWait,
            BIDDING_RUNTIME_METRIC_NAME.CommandQueueWait,
            BIDDING_RUNTIME_METRIC_NAME.StreamEventAge,
            BIDDING_RUNTIME_METRIC_NAME.OpenSeaRateLimitWait,
        ]) {
            expect(hasHistogramBucket(scrape, durationMetric, 0)).toBe(true);
        }
        for (const queueMetric of [
            BIDDING_RUNTIME_METRIC_NAME.JobRefreshQueueWait,
            BIDDING_RUNTIME_METRIC_NAME.HotRefreshQueueWait,
            BIDDING_RUNTIME_METRIC_NAME.OpenSeaRateLimitWait,
            BIDDING_RUNTIME_METRIC_NAME.BidBookProjectionQueueWait,
        ]) {
            expect(
                hasHistogramBucket(
                    scrape,
                    queueMetric,
                    BIDDING_RUNTIME_QUEUE_DURATION_BUCKETS_MS.at(-1)!,
                ),
            ).toBe(true);
        }
        expect(scrape).toContain(
            `result="${BIDDING_COMMAND_RECONCILIATION_RESULT.CompletedWithFailures}"`,
        );
        expect(scrape).toContain(
            `result="${BIDDER_SCAN_RESULT.CompletedWithFailures}"`,
        );

        for (const forbiddenLabel of BIDDING_RUNTIME_FORBIDDEN_HIGH_CARDINALITY_LABELS) {
            expect(scrape).not.toMatch(new RegExp(`[,{]${forbiddenLabel}="`));
        }
    });

    it("keeps runtime behavior authoritative when the metrics adapter throws", () => {
        const unavailableMetrics: Metrics = {
            increment: () => {
                throw new Error("counter unavailable");
            },
            gauge: () => {
                throw new Error("gauge unavailable");
            },
            histogram: () => {
                throw new Error("histogram unavailable");
            },
        };
        const observability = new BiddingRuntimeMetrics(unavailableMetrics);

        expect(() =>
            observability.setRuntimeState(
                BIDDING_RUNTIME_METRIC_STATE.Bootstrapping,
            ),
        ).not.toThrow();
        expect(() => observability.observeTimeToReady(10)).not.toThrow();
        expect(() =>
            observability.onRefreshPressureChanged({
                active: 1,
                waiting: 2,
                pending: 3,
            }),
        ).not.toThrow();
    });
});

function metric(name: string): string {
    return `${TRADING_METRICS_PREFIX}${name}`;
}

function hasHistogramBucket(
    scrape: string,
    name: string,
    bucket: number,
): boolean {
    return scrape
        .split("\n")
        .some(
            (line) =>
                line.startsWith(`${metric(name)}_bucket{`) &&
                line.includes(`le="${bucket}"`),
        );
}
