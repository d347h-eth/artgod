import { Mutex, Semaphore } from "async-mutex";
import { formatUnits } from "viem";
import {
    TRADING_BIDDING_JOB_RUNTIME_BID_POSITION,
    TRADING_BIDDING_JOB_RUNTIME_CONSTRAINT,
    type TradingBiddingJobRuntimeBidPosition,
    type TradingBiddingJobRuntimeConstraint,
} from "@artgod/shared/types";
import {
    getOpenSeaOfferCriteria,
    normalizeOpenSeaOfferTraitCriteria,
} from "@artgod/shared/trading/open-sea-bidding-offers";
import {
    MarketEvent,
    Scope,
    TraitCriterion,
} from "../../../domain/market/event.js";
import { TokenMetadataRepository } from "../../../domain/market/token-metadata-repository.js";
import {
    BIDDER_TARGET_TYPE,
    BidderJob,
    formatBidderJobReference,
} from "../../../domain/market/strategy/job.js";
import {
    BIDDING_LOG_COMPONENT,
    createBiddingComponentLogger,
    toErrorLogFields,
} from "../../../utils/bidding-log.js";
import { sleep } from "../../../utils/sleep.js";
import { observeBestEffort } from "../../../utils/observe-best-effort.js";
import {
    BIDDING_WORK_STAGE,
    observeBiddingWork,
    type BiddingWorkObservabilityPort,
} from "./bidding-work-observability.js";
import {
    BIDDER_DEFAULT_BOOTSTRAP_CONCURRENCY,
    BIDDER_DEFAULT_MAX_CONCURRENT_JOBS,
} from "./defaults.js";
import {
    BIDDING_ORDER_RECOVERY_STATUS,
    BIDDING_SERVICE_REQUEST_PRIORITY,
    BiddingService,
    type BiddingServiceRequestContext,
    Order,
} from "./bidding-service.js";
import { MakerWethBalanceService } from "./maker-weth-balance-service.js";

export interface BidderOptions {
    dryRun?: boolean;
    maxConcurrentJobs?: number;
    bootstrapConcurrency?: number;
}

// Stable refresh origins keep bidding pressure metrics low-cardinality.
export const BIDDER_REFRESH_TRIGGER = {
    FullScan: "full_scan",
    HotStream: "hot_stream",
    UserCommand: "user_command",
    RuntimeActivation: "runtime_activation",
    Internal: "internal",
} as const;

export type BidderRefreshTrigger =
    (typeof BIDDER_REFRESH_TRIGGER)[keyof typeof BIDDER_REFRESH_TRIGGER];

// Stable request outcomes distinguish newly scheduled refreshes from pending reruns.
export const BIDDER_REFRESH_REQUEST_OUTCOME = {
    Started: "started",
    Coalesced: "coalesced",
} as const;

export type BidderRefreshRequestOutcome =
    (typeof BIDDER_REFRESH_REQUEST_OUTCOME)[keyof typeof BIDDER_REFRESH_REQUEST_OUTCOME];

// Stable action kinds describe the market mutations owned by the bidder.
export const BIDDER_MARKET_ACTION = {
    PlaceOffer: "place_offer",
    CancelOffer: "cancel_offer",
} as const;

export type BidderMarketAction =
    (typeof BIDDER_MARKET_ACTION)[keyof typeof BIDDER_MARKET_ACTION];

// Intent is distinct from an attempted or completed marketplace mutation.
export const BIDDER_DECISION = {
    Place: "place",
    Renew: "renew",
    AdjustUp: "adjust_up",
    AdjustDown: "adjust_down",
    MaintainWinning: "maintain_winning",
    MaintainCapped: "maintain_capped",
    RevertToTarget: "revert_to_target",
    ZeroCeiling: "zero_ceiling",
} as const;
export type BidderDecision =
    (typeof BIDDER_DECISION)[keyof typeof BIDDER_DECISION];
export const BIDDER_OBSERVED_POSITION = {
    ...TRADING_BIDDING_JOB_RUNTIME_BID_POSITION,
    Unobserved: "unobserved",
} as const;
export type BidderPositionHealth = {
    positions: Record<
        (typeof BIDDER_OBSERVED_POSITION)[keyof typeof BIDDER_OBSERVED_POSITION],
        number
    >;
    constraints: Record<TradingBiddingJobRuntimeConstraint, number>;
};

// Stable scan results distinguish strategy failures from an interrupted scan.
export const BIDDER_SCAN_RESULT = {
    Success: "success",
    CompletedWithFailures: "completed_with_failures",
    Failure: "failure",
    Stopped: "stopped",
} as const;

export type BidderScanResult =
    (typeof BIDDER_SCAN_RESULT)[keyof typeof BIDDER_SCAN_RESULT];

// BidderObservabilityPort reports aggregate timing and pressure without exposing job identity.
export interface BidderObservabilityPort extends BiddingWorkObservabilityPort {
    onDecision?(input: {
        decision: BidderDecision;
        targetType: BidderJob["target"]["type"];
        dryRun: boolean;
    }): void;
    onScanProgress?(input: {
        active: boolean;
        total: number;
        completed: number;
        startedAtMs: number;
        lastProgressAtMs: number;
    }): void;
    onJobInventoryChanged(input: {
        total: number;
        targetCounts: Record<BidderJob["target"]["type"], number>;
    }): void;
    onScanFinished(input: {
        durationMs: number;
        jobCount: number;
        result: BidderScanResult;
    }): void;
    onRefreshRequested(input: {
        trigger: BidderRefreshTrigger;
        targetType: BidderJob["target"]["type"] | null;
        outcome: BidderRefreshRequestOutcome;
    }): void;
    onRefreshStarted(input: {
        trigger: BidderRefreshTrigger;
        targetType: BidderJob["target"]["type"];
        queueWaitMs: number;
    }): void;
    onRefreshFinished(input: {
        trigger: BidderRefreshTrigger;
        targetType: BidderJob["target"]["type"];
        durationMs: number;
        succeeded: boolean;
    }): void;
    onRefreshPressureChanged(input: {
        active: number;
        waiting: number;
        pending: number;
    }): void;
    onMarketActionFinished(input: {
        action: BidderMarketAction;
        targetType: BidderJob["target"]["type"];
        dryRun: boolean;
        durationMs: number;
        succeeded: boolean;
    }): void;
}

export type BiddingJobRuntimeStateSnapshot = {
    jobId: string;
    jobRevision: number;
    currentPriceWei: string | null;
    activeOrderId: string | null;
    activeProtocolAddress: string | null;
    activeOrderPlacedAt: string | null;
    activeOrderVerifiedAt: string | null;
    activeExpirationTimeMs: number | null;
    bidPosition: TradingBiddingJobRuntimeBidPosition | null;
    bidConstraints: TradingBiddingJobRuntimeConstraint[];
    competitorPriceWei: string | null;
    lastRunAt: string | null;
    lastError: string | null;
};

export type BiddingJobOfferCancellationSnapshot = {
    jobId: string;
    jobRevision: number;
    orderId: string;
    priceWei: string | null;
    protocolAddress: string | null;
    placedAt: string | null;
    expirationTimeMs: number | null;
    makerAddress: string;
    requestedAt: string;
    completedAt: string | null;
    cancellationError: string | null;
};

export interface BiddingJobRuntimeStatePort {
    persistJobRuntimeState(
        snapshot: BiddingJobRuntimeStateSnapshot,
    ): Promise<void> | void;
    recordJobOfferCancellation(
        snapshot: BiddingJobOfferCancellationSnapshot,
    ): Promise<void> | void;
}

export interface BidderRefreshPort {
    refreshMatchingJobs(marketEvent: MarketEvent): Promise<void>;
}

export interface BidderActivationOptions {
    floor: bigint;
    ceiling: bigint;
    ttlMs: number;
    reason?: string;
}

export interface BidderActivationPort {
    activateJob(jobId: string, options: BidderActivationOptions): Promise<void>;
}

interface HotRefreshEvaluation {
    jobId: string;
    matched: boolean;
    reason: string;
    eventType: string;
    eventScope: Scope;
    eventCollectionSlug: string;
    eventTokenId: string;
    eventUnitPrice: bigint;
    jobTargetType: BidderJob["target"]["type"];
    jobCollectionSlug: string;
    jobTokenId: string;
    currentPrice?: bigint;
    priceDiff?: bigint;
    traitCriteria: TraitCriterion[];
}

interface CurrentPriceCheckResult {
    shouldReact: boolean;
    reason: string;
    currentPrice?: bigint;
    priceDiff?: bigint;
}

interface HotRefreshNoEffectLogSummary {
    lastLoggedAt: number;
    suppressedCount: number;
    maxEventUnitPrice: bigint;
    sampleEventTarget: string;
}

interface ProgressContext {
    sequence: number;
    total: number;
}

export interface BidderBootstrapProgress {
    jobId: string;
    completed: number;
    total: number;
    warmed: boolean;
}

export interface BidderBootstrapOptions {
    onProgress?: (progress: BidderBootstrapProgress) => void;
}

interface JobExecutionState {
    running: boolean;
    executing: boolean;
    pending: boolean;
    inFlightPromise?: Promise<void>;
    pendingContext?: ProgressContext;
    pendingThrowOnFailure?: boolean;
    pendingRequestContext?: BiddingServiceRequestContext;
    pendingRequestedAt?: number;
    pendingTrigger?: BidderRefreshTrigger;
    pendingCompletionObservers?: JobRefreshCompletionObserver[];
}

type JobRefreshCompletionObserver = (succeeded: boolean) => void;

type JobExecutionOptions = {
    throwOnFailure: boolean;
    requestContext?: BiddingServiceRequestContext;
    trigger: BidderRefreshTrigger;
    requestedAt: number;
    onStrategyStarted?: (startedAtMs: number) => void;
    onCompleted?: JobRefreshCompletionObserver;
};

type RuntimeSatisfactionSnapshot = {
    activeOrderId: string;
    currentPrice: bigint;
    activeOrderVerifiedAt: string;
};

interface RuntimeJobOverride {
    activationId: number;
    floor: bigint;
    ceiling: bigint;
    expiresAt: number;
    reason?: string;
    timer?: ReturnType<typeof setTimeout>;
}

type RuntimeBidDecisionContext = {
    competitorPrice: bigint;
    floor: bigint;
    ceiling: bigint;
};

const log = createBiddingComponentLogger(BIDDING_LOG_COMPONENT.Bidder);

// No-effect hot refresh logs are summarized so unrelated stream flood does not dominate operator logs.
const BIDDER_HOT_REFRESH_NO_EFFECT_LOG_INTERVAL_MS = 10_000;

const BIDDING_COMMAND_REQUEST_CONTEXT: BiddingServiceRequestContext = {
    priority: BIDDING_SERVICE_REQUEST_PRIORITY.UserCommand,
};

const BIDDER_LOG_ACTION = {
    CurrentPriceBootstrapStarted: "currentPriceBootstrapStarted",
    CurrentPriceBootstrapCandidateStarted:
        "currentPriceBootstrapCandidateStarted",
    CurrentPriceBootstrapCandidateComplete:
        "currentPriceBootstrapCandidateComplete",
    CurrentPriceBootstrapComplete: "currentPriceBootstrapComplete",
    OfferCancellationPersistFailed: "offerCancellationPersistFailed",
    RuntimeStatePersistFailed: "runtimeStatePersistFailed",
    TrackedActiveOfferAlreadyAbsent: "trackedActiveOfferAlreadyAbsent",
} as const;

// Bidder is the pure bidding core ported from the production bot with mechanical renames only.
export class Bidder implements BidderRefreshPort, BidderActivationPort {
    private readonly jobs = new Map<string, BidderJob>();
    private readonly tokenJobIdByCollectionToken = new Map<string, string>();
    private readonly tokenJobIdsByCollection = new Map<string, Set<string>>();
    private readonly jobExecutionStates = new Map<string, JobExecutionState>();
    private readonly jobMutexes = new Map<string, Mutex>();
    private readonly runtimeOverrides = new Map<string, RuntimeJobOverride>();
    private readonly activeRefreshes = new Set<Promise<void>>();
    private readonly hotRefreshNoEffectLogSummaries = new Map<
        string,
        HotRefreshNoEffectLogSummary
    >();
    private cachedMakerWethBalance?: bigint;
    private readonly jobExecutionSemaphore: Semaphore;
    private readonly maxConcurrentJobs: number;
    private readonly bootstrapConcurrency: number;
    private readonly jobTargetCounts: Record<
        BidderJob["target"]["type"],
        number
    > = {
        [BIDDER_TARGET_TYPE.Token]: 0,
        [BIDDER_TARGET_TYPE.Collection]: 0,
        [BIDDER_TARGET_TYPE.CompetitiveTrait]: 0,
    };
    private activeRefreshCount = 0;
    private waitingRefreshCount = 0;
    private pendingRefreshCount = 0;
    private nextActivationId = 1;
    private started = false;
    private acceptingRefreshes = true;
    private acceptingBackgroundRefreshes = true;
    private scanSleepTimer?: ReturnType<typeof setTimeout>;
    private activeScanPromise?: Promise<void>;

    constructor(
        private readonly biddingService: BiddingService,
        private readonly makerAddress: string,
        private readonly scanSleepMs: number,
        private readonly options: BidderOptions = {},
        private readonly tokenMetadataRepository?: TokenMetadataRepository,
        private readonly makerWethBalanceService?: MakerWethBalanceService,
        private readonly runtimeStatePort?: BiddingJobRuntimeStatePort,
        private readonly observability?: BidderObservabilityPort,
    ) {
        this.maxConcurrentJobs = this.resolveMaxConcurrentJobs(
            options.maxConcurrentJobs,
        );
        this.bootstrapConcurrency = this.resolveBootstrapConcurrency(
            options.bootstrapConcurrency,
        );
        this.jobExecutionSemaphore = new Semaphore(this.maxConcurrentJobs);
        this.reportJobInventory();
        this.reportRefreshPressure();
    }

    public addJob(job: BidderJob): void {
        const existingJob = this.jobs.get(job.id);
        if (existingJob) {
            if (this.hasSameTargetIdentity(existingJob, job)) {
                job.state = {
                    ...existingJob.state,
                    ...job.state,
                };
            }
            this.removeJobFromIndexes(existingJob);
            this.adjustJobTargetCount(existingJob.target.type, -1);
        }

        this.jobs.set(job.id, job);
        this.addJobToIndexes(job);
        this.adjustJobTargetCount(job.target.type, 1);
        this.reportJobInventory();
    }

    public getJob(jobId: string): BidderJob | undefined {
        return this.jobs.get(jobId);
    }

    // Stream the current schedule at the health-sampling cadence; never allocate per-job time series.
    public readPositionHealth(): BidderPositionHealth {
        const positions = Object.fromEntries(
            Object.values(BIDDER_OBSERVED_POSITION).map((value) => [value, 0]),
        ) as BidderPositionHealth["positions"];
        const constraints = Object.fromEntries(
            Object.values(TRADING_BIDDING_JOB_RUNTIME_CONSTRAINT).map(
                (value) => [value, 0],
            ),
        ) as BidderPositionHealth["constraints"];
        for (const job of this.jobs.values()) {
            positions[
                job.state.bidPosition ?? BIDDER_OBSERVED_POSITION.Unobserved
            ] += 1;
            for (const constraint of new Set(job.state.bidConstraints ?? []))
                constraints[constraint] += 1;
        }
        return { positions, constraints };
    }

    public removeJob(jobId: string): BidderJob | undefined {
        const existingJob = this.jobs.get(jobId);
        if (!existingJob) {
            return undefined;
        }

        this.clearRuntimeOverride(jobId);
        this.removeJobFromIndexes(existingJob);
        this.jobs.delete(jobId);
        this.adjustJobTargetCount(existingJob.target.type, -1);
        this.reportJobInventory();
        return existingJob;
    }

    public async cancelActiveOffersForJob(
        job: BidderJob,
        requestContext: BiddingServiceRequestContext = {},
    ): Promise<number> {
        const jobMutex = this.getJobMutex(job.id);
        return await jobMutex.runExclusive(async () => {
            const jobRef = formatBidderJobReference(job);
            log.info(
                "discoverActiveMakerOffersForCancellation",
                "Discovering active maker offers for cancellation",
                {
                    jobId: job.id,
                    jobRef,
                    collectionSlug: job.collectionSlug,
                    targetType: job.target.type,
                },
            );
            // Fetch active offers through the bidding service so cancellation uses the same market scope as normal refreshes.
            const offers = await this.readActiveOffers(job, requestContext);
            const trackedOrderId = job.state.activeOrderId;
            const trackedOrder = await this.resolveTrackedActiveOrder(
                job,
                offers,
                jobRef,
                false,
                requestContext,
            );
            const cancellationCandidates =
                trackedOrder &&
                !offers.some((offer) => offer.id === trackedOrder.id)
                    ? [...offers, trackedOrder]
                    : offers;
            const makerAddress = this.makerAddress.toLowerCase();
            const makerOffers = cancellationCandidates.filter(
                (offer) =>
                    offer.maker.toLowerCase() === makerAddress &&
                    (this.isOfferManagedByJob(job, offer) ||
                        offer.id === trackedOrderId),
            );
            if (makerOffers.length === 0) {
                if (trackedOrderId) {
                    const completedAt = new Date().toISOString();
                    log.info(
                        BIDDER_LOG_ACTION.TrackedActiveOfferAlreadyAbsent,
                        "Tracked active offer is already absent; treating cancellation as complete",
                        {
                            jobId: job.id,
                            jobRef,
                            collectionSlug: job.collectionSlug,
                            targetType: job.target.type,
                            orderId: trackedOrderId,
                        },
                    );
                    this.recordTrackedOrderCancellation(job, {
                        requestedAt: completedAt,
                        completedAt,
                        cancellationError: null,
                    });
                    this.clearTrackedOrder(job);
                    return 0;
                }

                log.info(
                    "noActiveMakerOffersForCancellation",
                    "No active maker offers found for cancellation",
                    {
                        jobId: job.id,
                        jobRef,
                        collectionSlug: job.collectionSlug,
                        targetType: job.target.type,
                    },
                );
                this.clearTrackedOrder(job);
                return 0;
            }

            log.info(
                "cancelActiveMakerOffers",
                "Cancelling active maker offers",
                {
                    jobId: job.id,
                    jobRef,
                    collectionSlug: job.collectionSlug,
                    targetType: job.target.type,
                    offerCount: makerOffers.length,
                },
            );
            await this.cancelMakerOffers(
                job,
                makerOffers,
                undefined,
                requestContext,
            );
            this.clearTrackedOrder(job);
            return makerOffers.length;
        });
    }

    public async cancelActiveOffersForCommand(job: BidderJob): Promise<number> {
        return await this.cancelActiveOffersForJob(
            job,
            BIDDING_COMMAND_REQUEST_CONTEXT,
        );
    }

    public async activateJob(
        jobId: string,
        options: BidderActivationOptions,
    ): Promise<void> {
        if (!this.acceptingBackgroundRefreshes) {
            return;
        }
        const job = this.jobs.get(jobId);
        if (!job) {
            throw new Error(`[Bidder] Cannot activate unknown job: ${jobId}`);
        }

        if (options.ttlMs <= 0 || !Number.isFinite(options.ttlMs)) {
            throw new Error(
                `[Bidder] ttlMs must be > 0. received=${options.ttlMs}`,
            );
        }

        if (options.floor > options.ceiling) {
            throw new Error(
                `[Bidder] Activation floor must be <= ceiling. floor=${options.floor}, ceiling=${options.ceiling}`,
            );
        }

        this.clearRuntimeOverride(jobId);

        const override: RuntimeJobOverride = {
            activationId: this.nextActivationId++,
            floor: options.floor,
            ceiling: options.ceiling,
            expiresAt: Date.now() + options.ttlMs,
            reason: options.reason,
        };
        override.timer = this.scheduleRuntimeOverrideExpiry(jobId, override);
        this.runtimeOverrides.set(jobId, override);

        log.info("runtimeOverrideActivated", "Activated runtime override", {
            jobId,
            floorWei: options.floor.toString(),
            floorEth: formatUnits(options.floor, 18),
            ceilingWei: options.ceiling.toString(),
            ceilingEth: formatUnits(options.ceiling, 18),
            ttlMs: options.ttlMs,
            reason: options.reason ?? "unspecified",
        });

        await this.refreshJobImmediately(jobId, {
            throwOnFailure: false,
            trigger: BIDDER_REFRESH_TRIGGER.RuntimeActivation,
            requestedAt: Date.now(),
        });
    }

    public async bootstrapCurrentPrices(
        options: BidderBootstrapOptions = {},
    ): Promise<void> {
        const tokenJobIds = Array.from(
            this.tokenJobIdByCollectionToken.values(),
        );
        const warmCandidates = tokenJobIds
            .map((jobId) => this.jobs.get(jobId))
            .filter(
                (job): job is BidderJob =>
                    !!job &&
                    job.target.type === BIDDER_TARGET_TYPE.Token &&
                    job.state.currentPrice === undefined,
            );
        let warmedCount = 0;
        let nextCandidateIndex = 0;
        const concurrency = Math.min(
            this.bootstrapConcurrency,
            warmCandidates.length,
        );
        let completedCount = 0;

        log.debug(
            BIDDER_LOG_ACTION.CurrentPriceBootstrapStarted,
            "Bootstrapping current prices",
            {
                candidateCount: warmCandidates.length,
                tokenJobCount: tokenJobIds.length,
                concurrency,
            },
        );

        await sleep(1000);

        const workers = Array.from({ length: concurrency }, async () => {
            while (true) {
                const candidateIndex = nextCandidateIndex;
                const job = warmCandidates[candidateIndex];
                if (!job) {
                    return;
                }
                nextCandidateIndex++;

                log.debug(
                    BIDDER_LOG_ACTION.CurrentPriceBootstrapCandidateStarted,
                    "Bootstrapping current price candidate",
                    {
                        jobId: job.id,
                        jobRef: formatBidderJobReference(job),
                        sequence: candidateIndex + 1,
                        total: warmCandidates.length,
                    },
                );
                const warmed = await this.tryWarmCurrentPrice(job, {
                    sequence: candidateIndex + 1,
                    total: warmCandidates.length,
                });
                completedCount++;
                log.debug(
                    BIDDER_LOG_ACTION.CurrentPriceBootstrapCandidateComplete,
                    "Current price bootstrap candidate complete",
                    {
                        jobId: job.id,
                        jobRef: formatBidderJobReference(job),
                        completed: completedCount,
                        total: warmCandidates.length,
                        warmed,
                    },
                );
                options.onProgress?.({
                    jobId: job.id,
                    completed: completedCount,
                    total: warmCandidates.length,
                    warmed,
                });
                if (warmed) {
                    warmedCount++;
                }
            }
        });

        await Promise.all(workers);

        log.debug(
            BIDDER_LOG_ACTION.CurrentPriceBootstrapComplete,
            "Current price bootstrap complete",
            {
                candidateCount: warmCandidates.length,
                warmedCount,
                missingCount: warmCandidates.length - warmedCount,
                alreadySetCount: tokenJobIds.length - warmCandidates.length,
            },
        );
    }

    public getTokenTargetIds(): string[] {
        const tokenTargetIds = new Set<string>();

        for (const job of this.jobs.values()) {
            if (job.target.type !== BIDDER_TARGET_TYPE.Token) {
                continue;
            }
            tokenTargetIds.add(job.target.tokenId);
        }

        return Array.from(tokenTargetIds);
    }

    public async refreshMatchingJobs(marketEvent: MarketEvent): Promise<void> {
        const evaluations = await this.evaluateHotRefresh(marketEvent);
        const matchingJobIds = evaluations
            .filter((evaluation) => evaluation.matched)
            .map((evaluation) => evaluation.jobId);

        if (matchingJobIds.length === 0) {
            this.logNoEffectHotRefresh(marketEvent, evaluations);
            return;
        }

        evaluations
            .filter((evaluation) => evaluation.matched)
            .forEach((evaluation) => this.logHotRefreshEffect(evaluation));

        if (this.isBroadHotRefreshEvent(marketEvent)) {
            await this.refreshBroadMatchingJobs(matchingJobIds);
            return;
        }

        await Promise.all(
            matchingJobIds.map((jobId) =>
                this.refreshJob(
                    jobId,
                    undefined,
                    BIDDER_REFRESH_TRIGGER.HotStream,
                ),
            ),
        );
    }

    public start(): void {
        if (this.started || !this.acceptingBackgroundRefreshes) {
            return;
        }

        this.started = true;
        this.startScanPass();
    }

    // Close background admission before draining durable commands that may still need strategy work.
    public closeBackgroundRefreshAdmission(): void {
        this.started = false;
        this.acceptingBackgroundRefreshes = false;
        if (this.scanSleepTimer) {
            clearTimeout(this.scanSleepTimer);
            this.scanSleepTimer = undefined;
        }
        // Cancel expiry callbacks without changing the policy seen by strategy work already in flight.
        for (const override of this.runtimeOverrides.values()) {
            if (override.timer) {
                clearTimeout(override.timer);
                override.timer = undefined;
            }
        }

        for (const state of this.jobExecutionStates.values()) {
            this.combineRefreshCompletionObservers(
                state.pendingCompletionObservers,
            )?.(false);
            this.clearPendingRefresh(state);
        }
        this.reportRefreshPressure();
    }

    // Discard background waiters; finish active strategy work and already-admitted commands.
    public async stop(): Promise<void> {
        this.acceptingRefreshes = false;
        this.closeBackgroundRefreshAdmission();

        await Promise.allSettled([
            ...(this.activeScanPromise ? [this.activeScanPromise] : []),
            ...Array.from(this.activeRefreshes),
        ]);
        this.runtimeOverrides.clear();
    }

    public async scanOnce(): Promise<void> {
        const startedAt = Date.now();
        const jobs = Array.from(this.jobs.values());
        let completed = 0;
        const reportProgress = (active: boolean) =>
            observeBestEffort(() =>
                this.observability?.onScanProgress?.({
                    active,
                    total: jobs.length,
                    completed,
                    startedAtMs: startedAt,
                    lastProgressAtMs: Date.now(),
                }),
            );
        reportProgress(true);
        let result: BidderScanResult = BIDDER_SCAN_RESULT.Failure;
        try {
            const refreshed = await this.refreshCachedMakerWethBalance();
            log.debug("scanStarted", "Bidder full job scan started", {
                makerAddress: this.makerAddress,
                makerWethBalanceWei:
                    this.cachedMakerWethBalance?.toString() ?? null,
                makerWethBalance: this.formatScanBalanceForLog(),
                makerWethBalanceRefreshed: refreshed,
                makerWethBalanceCached:
                    !refreshed && this.cachedMakerWethBalance !== undefined,
            });
            const refreshResults = await Promise.all(
                jobs.map(async (job, index) => {
                    try {
                        return await this.refreshJobForScan(job.id, {
                            sequence: index + 1,
                            total: jobs.length,
                        });
                    } finally {
                        completed += 1;
                        reportProgress(true);
                    }
                }),
            );
            if (!this.acceptingBackgroundRefreshes) {
                result = BIDDER_SCAN_RESULT.Stopped;
            } else {
                result = refreshResults.every((succeeded) => succeeded)
                    ? BIDDER_SCAN_RESULT.Success
                    : BIDDER_SCAN_RESULT.CompletedWithFailures;
            }
        } finally {
            reportProgress(false);
            observeBestEffort(() => {
                this.observability?.onScanFinished({
                    durationMs: Date.now() - startedAt,
                    jobCount: jobs.length,
                    result,
                });
            });
        }
    }

    private async refreshJobForScan(
        jobId: string,
        context: ProgressContext,
    ): Promise<boolean> {
        let completed = false;
        let succeeded = false;
        try {
            await this.refreshJobWithOptions(jobId, context, {
                throwOnFailure: false,
                trigger: BIDDER_REFRESH_TRIGGER.FullScan,
                requestedAt: Date.now(),
                onCompleted: (refreshSucceeded) => {
                    completed = true;
                    succeeded = refreshSucceeded;
                },
            });
        } catch (error: unknown) {
            if (!completed) {
                throw error;
            }
        }

        return completed && succeeded;
    }

    public async refreshJob(
        jobId: string,
        context?: ProgressContext,
        trigger: BidderRefreshTrigger = BIDDER_REFRESH_TRIGGER.Internal,
    ): Promise<void> {
        return await this.refreshJobWithOptions(jobId, context, {
            throwOnFailure: false,
            trigger,
            requestedAt: Date.now(),
        });
    }

    public async refreshJobForCommand(
        jobId: string,
        onStrategyStarted?: (startedAtMs: number) => void,
    ): Promise<void> {
        await this.refreshCachedMakerWethBalance();
        return await this.refreshJobImmediately(jobId, {
            throwOnFailure: true,
            requestContext: BIDDING_COMMAND_REQUEST_CONTEXT,
            trigger: BIDDER_REFRESH_TRIGGER.UserCommand,
            requestedAt: Date.now(),
            onStrategyStarted,
        });
    }

    // Reports whether this process has already verified an active order for the same durable job declaration.
    public getSatisfiedRuntimeSnapshot(
        desiredJob: BidderJob,
    ): RuntimeSatisfactionSnapshot | null {
        const currentJob = this.jobs.get(desiredJob.id);
        if (!currentJob) {
            return null;
        }

        if (!this.hasSameSatisfiedDeclaration(currentJob, desiredJob)) {
            return null;
        }

        const activeOrderId = currentJob.state.activeOrderId;
        const currentPrice = currentJob.state.currentPrice;
        const activeOrderVerifiedAt = currentJob.state.activeOrderVerifiedAt;
        if (
            !activeOrderId ||
            currentPrice === undefined ||
            !activeOrderVerifiedAt
        ) {
            return null;
        }

        return {
            activeOrderId,
            currentPrice,
            activeOrderVerifiedAt,
        };
    }

    private async refreshBroadMatchingJobs(jobIds: string[]): Promise<void> {
        for (const jobId of jobIds) {
            await this.refreshJob(
                jobId,
                undefined,
                BIDDER_REFRESH_TRIGGER.HotStream,
            );
        }
    }

    private isBroadHotRefreshEvent(marketEvent: MarketEvent): boolean {
        return (
            marketEvent.getScope() === Scope.Collection ||
            marketEvent.getScope() === Scope.Trait
        );
    }

    private async refreshJobWithOptions(
        jobId: string,
        context: ProgressContext | undefined,
        options: JobExecutionOptions,
    ): Promise<void> {
        if (!this.acceptingBackgroundRefreshes) {
            options.onCompleted?.(false);
            return;
        }
        const state = this.getJobExecutionState(jobId);
        const targetType = this.jobs.get(jobId)?.target.type ?? null;

        if (state.running) {
            this.setRefreshPending(state, true);
            if (context) {
                state.pendingContext = context;
            }
            state.pendingThrowOnFailure =
                state.pendingThrowOnFailure || options.throwOnFailure;
            if (options.requestContext) {
                state.pendingRequestContext = options.requestContext;
            }
            state.pendingRequestedAt = Math.min(
                state.pendingRequestedAt ?? options.requestedAt,
                options.requestedAt,
            );
            state.pendingTrigger = options.trigger;
            if (options.onCompleted) {
                state.pendingCompletionObservers ??= [];
                state.pendingCompletionObservers.push(options.onCompleted);
            }
            observeBestEffort(() => {
                this.observability?.onRefreshRequested({
                    trigger: options.trigger,
                    targetType,
                    outcome: BIDDER_REFRESH_REQUEST_OUTCOME.Coalesced,
                });
            });
            this.reportRefreshPressure();
            return state.inFlightPromise ?? Promise.resolve();
        }

        observeBestEffort(() => {
            this.observability?.onRefreshRequested({
                trigger: options.trigger,
                targetType,
                outcome: BIDDER_REFRESH_REQUEST_OUTCOME.Started,
            });
        });
        state.running = true;
        this.clearPendingRefresh(state);
        this.waitingRefreshCount += 1;
        this.reportRefreshPressure();
        state.inFlightPromise = this.trackRefresh(
            this.runJobRefreshLoop(jobId, state, context, options).finally(
                () => {
                    state.running = false;
                    this.clearPendingRefresh(state);
                    state.inFlightPromise = undefined;
                    this.reportRefreshPressure();
                },
            ),
        );

        return state.inFlightPromise;
    }

    private isDryRun(): boolean {
        return this.options.dryRun === true;
    }

    private async runJobRefreshLoop(
        jobId: string,
        state: JobExecutionState,
        context: ProgressContext | undefined,
        options: JobExecutionOptions,
    ): Promise<void> {
        let nextContext = context;
        let nextOptions = options;

        while (true) {
            await this.jobExecutionSemaphore.runExclusive(async () => {
                const jobMutex = this.getJobMutex(jobId);
                await jobMutex.runExclusive(async () => {
                    this.waitingRefreshCount = Math.max(
                        0,
                        this.waitingRefreshCount - 1,
                    );
                    // Admission may close while this refresh waits for either execution lock.
                    if (!this.acceptingBackgroundRefreshes) {
                        nextOptions.onCompleted?.(false);
                        this.reportRefreshPressure();
                        return;
                    }
                    this.activeRefreshCount += 1;
                    state.executing = true;
                    const startedAt = Date.now();
                    const job = this.jobs.get(jobId);
                    if (job) {
                        observeBestEffort(() => {
                            this.observability?.onRefreshStarted({
                                trigger: nextOptions.trigger,
                                targetType: job.target.type,
                                queueWaitMs: Math.max(
                                    0,
                                    startedAt - nextOptions.requestedAt,
                                ),
                            });
                        });
                    }
                    nextOptions.onStrategyStarted?.(startedAt);
                    this.reportRefreshPressure();
                    try {
                        await this.executeJob(jobId, nextContext, nextOptions);
                    } finally {
                        state.executing = false;
                        this.activeRefreshCount = Math.max(
                            0,
                            this.activeRefreshCount - 1,
                        );
                        this.reportRefreshPressure();
                    }
                });
            });

            if (!state.pending) {
                return;
            }

            nextContext = state.pendingContext;
            nextOptions = {
                throwOnFailure: state.pendingThrowOnFailure === true,
                requestContext: state.pendingRequestContext,
                trigger:
                    state.pendingTrigger ?? BIDDER_REFRESH_TRIGGER.Internal,
                requestedAt: state.pendingRequestedAt ?? Date.now(),
                onCompleted: this.combineRefreshCompletionObservers(
                    state.pendingCompletionObservers,
                ),
            };
            this.clearPendingRefresh(state);
            this.waitingRefreshCount += 1;
            this.reportRefreshPressure();
        }
    }

    private getJobExecutionState(jobId: string): JobExecutionState {
        let state = this.jobExecutionStates.get(jobId);
        if (!state) {
            state = { running: false, executing: false, pending: false };
            this.jobExecutionStates.set(jobId, state);
        }

        return state;
    }

    private reportJobInventory(): void {
        observeBestEffort(() => {
            this.observability?.onJobInventoryChanged({
                total: this.jobs.size,
                targetCounts: { ...this.jobTargetCounts },
            });
        });
    }

    private reportRefreshPressure(): void {
        observeBestEffort(() => {
            this.observability?.onRefreshPressureChanged({
                active: this.activeRefreshCount,
                waiting: this.waitingRefreshCount,
                pending: this.pendingRefreshCount,
            });
        });
    }

    private adjustJobTargetCount(
        targetType: BidderJob["target"]["type"],
        delta: number,
    ): void {
        this.jobTargetCounts[targetType] = Math.max(
            0,
            this.jobTargetCounts[targetType] + delta,
        );
    }

    private setRefreshPending(
        state: JobExecutionState,
        pending: boolean,
    ): void {
        if (state.pending === pending) {
            return;
        }
        state.pending = pending;
        this.pendingRefreshCount = Math.max(
            0,
            this.pendingRefreshCount + (pending ? 1 : -1),
        );
    }

    private clearPendingRefresh(state: JobExecutionState): void {
        this.setRefreshPending(state, false);
        state.pendingContext = undefined;
        state.pendingThrowOnFailure = undefined;
        state.pendingRequestContext = undefined;
        state.pendingRequestedAt = undefined;
        state.pendingTrigger = undefined;
        state.pendingCompletionObservers = undefined;
    }

    private combineRefreshCompletionObservers(
        observers: JobRefreshCompletionObserver[] | undefined,
    ): JobRefreshCompletionObserver | undefined {
        if (!observers || observers.length === 0) {
            return undefined;
        }

        return (succeeded) => {
            for (const observer of observers) {
                observer(succeeded);
            }
        };
    }

    private async refreshJobImmediately(
        jobId: string,
        options: JobExecutionOptions,
    ): Promise<void> {
        if (!this.acceptingRefreshes) {
            if (options.trigger === BIDDER_REFRESH_TRIGGER.UserCommand) {
                throw new Error(
                    "Cannot refresh a bidding job after the bidder has stopped",
                );
            }
            return;
        }
        if (
            !this.acceptingBackgroundRefreshes &&
            options.trigger !== BIDDER_REFRESH_TRIGGER.UserCommand
        ) {
            return;
        }
        log.debug(
            "immediateRefreshStarted",
            "Executing immediate bidding job refresh",
            {
                jobId,
            },
        );
        const jobMutex = this.getJobMutex(jobId);
        const targetType = this.jobs.get(jobId)?.target.type ?? null;
        observeBestEffort(() => {
            this.observability?.onRefreshRequested({
                trigger: options.trigger,
                targetType,
                outcome: BIDDER_REFRESH_REQUEST_OUTCOME.Started,
            });
        });
        this.waitingRefreshCount += 1;
        this.reportRefreshPressure();
        await this.trackRefresh(
            jobMutex.runExclusive(async () => {
                this.waitingRefreshCount = Math.max(
                    0,
                    this.waitingRefreshCount - 1,
                );
                // Preserve an admitted durable command, but discard queued activation/expiry work.
                if (
                    !this.acceptingBackgroundRefreshes &&
                    options.trigger !== BIDDER_REFRESH_TRIGGER.UserCommand
                ) {
                    this.reportRefreshPressure();
                    return;
                }
                this.activeRefreshCount += 1;
                const startedAt = Date.now();
                const job = this.jobs.get(jobId);
                if (job) {
                    observeBestEffort(() => {
                        this.observability?.onRefreshStarted({
                            trigger: options.trigger,
                            targetType: job.target.type,
                            queueWaitMs: Math.max(
                                0,
                                startedAt - options.requestedAt,
                            ),
                        });
                    });
                }
                observeBestEffort(() => {
                    options.onStrategyStarted?.(startedAt);
                });
                this.reportRefreshPressure();
                try {
                    await this.executeJob(jobId, undefined, options);
                } finally {
                    this.activeRefreshCount = Math.max(
                        0,
                        this.activeRefreshCount - 1,
                    );
                    this.reportRefreshPressure();
                }
            }),
        );
    }

    private trackRefresh(refresh: Promise<void>): Promise<void> {
        this.activeRefreshes.add(refresh);
        void refresh.then(
            () => this.activeRefreshes.delete(refresh),
            () => this.activeRefreshes.delete(refresh),
        );
        return refresh;
    }

    private async runScanLoop(): Promise<void> {
        if (!this.started) {
            return;
        }

        try {
            await this.scanOnce();
        } catch (error: unknown) {
            log.error("scanFailed", "Bidder full job scan failed", {
                ...toErrorLogFields(error),
            });
        }

        if (!this.started) {
            return;
        }

        this.scanSleepTimer = setTimeout(() => {
            this.startScanPass();
        }, this.scanSleepMs);
    }

    private startScanPass(): void {
        const scan = this.runScanLoop();
        this.activeScanPromise = scan;
        void scan.then(
            () => {
                if (this.activeScanPromise === scan) {
                    this.activeScanPromise = undefined;
                }
            },
            () => {
                if (this.activeScanPromise === scan) {
                    this.activeScanPromise = undefined;
                }
            },
        );
    }

    private async executeJob(
        jobId: string,
        context: ProgressContext | undefined,
        options: JobExecutionOptions,
    ): Promise<void> {
        const startedAt = Date.now();
        let failed = false;
        let targetType: BidderJob["target"]["type"] | undefined;
        try {
            const job = this.jobs.get(jobId);
            if (!job) {
                return;
            }
            targetType = job.target.type;
            const runtimeOverride = this.getRuntimeOverride(job.id);

            const counter = context
                ? { sequence: context.sequence, total: context.total }
                : {};
            const jobRef = formatBidderJobReference(job);
            log.debug("jobRefreshStarted", "Executing bidding job strategy", {
                jobId: job.id,
                jobRef,
                collectionSlug: job.collectionSlug,
                targetType: job.target.type,
                ...counter,
            });

            const requestContext = options.requestContext ?? {};
            const offers = await this.readActiveOffers(job, requestContext);
            const trackedOrder = await this.resolveTrackedActiveOrder(
                job,
                offers,
                jobRef,
                true,
                requestContext,
            );
            if (
                trackedOrder &&
                !offers.some((offer) => offer.id === trackedOrder.id)
            ) {
                offers.push(trackedOrder);
            }

            const sortedOffers = [...offers].sort((left, right) => {
                if (left.price > right.price) {
                    return -1;
                }
                if (left.price < right.price) {
                    return 1;
                }
                return 0;
            });

            const myAddress = this.makerAddress.toLowerCase();
            const isMakerOffer = (offer: Order): boolean =>
                offer.maker.toLowerCase() === myAddress;
            const visibleMyOffers = sortedOffers.filter(isMakerOffer);
            const myOffers = visibleMyOffers.filter((offer) =>
                this.isOfferManagedByJob(job, offer),
            );
            const competitorOffers = sortedOffers.filter(
                (offer) => !isMakerOffer(offer),
            );
            const myHighest = myOffers[0];
            const competitorHighest = competitorOffers[0];

            const configuredFloor = runtimeOverride?.floor ?? job.config.floor;
            const configuredCeiling =
                runtimeOverride?.ceiling ?? job.config.ceiling;
            const floor = this.getEffectiveFloor(configuredFloor);
            const ceiling = this.getEffectiveCeiling(configuredCeiling);
            const delta = job.config.delta;

            const competitorPrice = competitorHighest
                ? competitorHighest.price
                : 0n;

            const formatOptionalUnit = (value: bigint | undefined): string =>
                value === undefined ? "None" : formatUnits(value, 18);

            const formatOffer = (offer: Order | undefined): string =>
                offer
                    ? `${formatUnits(offer.price, 18)} (source=${offer.offerScope ?? "unknown"}, priceSource=${offer.priceSource ?? offer.source ?? "unknown"}, qty=${offer.quantity ?? 1n})`
                    : "None";

            log.debug("jobStateEvaluated", "Bidding job state evaluated", {
                jobId: job.id,
                jobRef,
                collectionSlug: job.collectionSlug,
                targetType: job.target.type,
                myHighest: formatOffer(myHighest),
                competitorHighest: formatOffer(competitorHighest),
                configuredFloor: formatOptionalUnit(configuredFloor),
                effectiveFloor: formatOptionalUnit(floor),
                configuredCeiling: formatOptionalUnit(configuredCeiling),
                effectiveCeiling: formatOptionalUnit(ceiling),
                cachedMakerWethBalance: formatOptionalUnit(
                    this.cachedMakerWethBalance,
                ),
            });
            if (runtimeOverride) {
                log.debug(
                    "runtimeOverrideActive",
                    "Runtime override is active",
                    {
                        jobId: job.id,
                        jobRef,
                        baseFloor: formatOptionalUnit(job.config.floor),
                        baseCeiling: formatOptionalUnit(job.config.ceiling),
                        overrideExpiresAt: new Date(
                            runtimeOverride.expiresAt,
                        ).toISOString(),
                        reason: runtimeOverride.reason ?? "unspecified",
                    },
                );
            }

            const desiredPrice = this.getDesiredBid(
                floor,
                ceiling,
                competitorPrice,
                delta,
            );
            const renewalReason = myHighest
                ? this.getBidRenewalReason(job, myHighest)
                : undefined;

            if (desiredPrice <= 0n) {
                this.reportDecision(job, BIDDER_DECISION.ZeroCeiling);
                if (myOffers.length > 0) {
                    log.info(
                        "zeroCeilingCancelOffers",
                        "Effective ceiling is zero; cancelling maker offers",
                        {
                            jobId: job.id,
                            jobRef,
                            offerCount: myOffers.length,
                        },
                    );
                    await this.cancelMakerOffers(
                        job,
                        myOffers,
                        undefined,
                        requestContext,
                    );
                    this.clearTrackedOrder(job);
                    return;
                }

                log.debug(
                    "zeroCeilingSkip",
                    "Skipping job because effective ceiling is zero",
                    {
                        jobId: job.id,
                        jobRef,
                    },
                );
                this.clearRuntimeBidDecision(job);
                this.persistJobRuntimeState(job);
                return;
            }

            if (!myHighest) {
                this.reportDecision(job, BIDDER_DECISION.Place);
                log.debug(
                    "noActiveBidPlaceTarget",
                    "No active bid; placing target",
                    {
                        jobId: job.id,
                        jobRef,
                        desiredPriceWei: desiredPrice.toString(),
                        desiredPriceEth: formatUnits(desiredPrice, 18),
                    },
                );
                this.clearRuntimeBidDecision(job);
                await this.placeAndTrack(
                    job,
                    desiredPrice,
                    {
                        competitorPrice,
                        floor,
                        ceiling,
                    },
                    requestContext,
                );
                return;
            }

            const myPrice = myHighest.price;
            const matchingMakerOffer = myOffers.find(
                (offer) => offer.price === desiredPrice,
            );

            if (renewalReason) {
                this.reportDecision(job, BIDDER_DECISION.Renew);
                log.info("bidRenewal", "Renewing bid", {
                    jobId: job.id,
                    jobRef,
                    currentPriceWei: myPrice.toString(),
                    currentPriceEth: formatUnits(myPrice, 18),
                    desiredPriceWei: desiredPrice.toString(),
                    desiredPriceEth: formatUnits(desiredPrice, 18),
                    reason: renewalReason,
                });
                this.clearRuntimeBidDecision(job);
                await this.placeAndTrack(
                    job,
                    desiredPrice,
                    {
                        competitorPrice,
                        floor,
                        ceiling,
                    },
                    requestContext,
                );
                await this.cancelMakerOffers(
                    job,
                    myOffers,
                    undefined,
                    requestContext,
                );
                return;
            }

            if (matchingMakerOffer) {
                this.reportDecision(
                    job,
                    matchingMakerOffer.id !== myHighest.id
                        ? BIDDER_DECISION.RevertToTarget
                        : desiredPrice > competitorPrice
                          ? BIDDER_DECISION.MaintainWinning
                          : BIDDER_DECISION.MaintainCapped,
                );
                this.trackRuntimeBidDecision(
                    job,
                    matchingMakerOffer.price,
                    competitorPrice,
                    floor,
                    ceiling,
                );
                this.trackCurrentOrder(job, matchingMakerOffer);
                await this.cancelMakerOffers(
                    job,
                    myOffers,
                    matchingMakerOffer.id,
                    requestContext,
                );

                if (matchingMakerOffer.id !== myHighest.id) {
                    log.info("revertToTargetBid", "Reverting to target bid", {
                        jobId: job.id,
                        jobRef,
                        desiredPriceWei: desiredPrice.toString(),
                        desiredPriceEth: formatUnits(desiredPrice, 18),
                        competitorPriceWei: competitorPrice.toString(),
                        competitorPriceEth: formatUnits(competitorPrice, 18),
                    });
                } else if (desiredPrice > competitorPrice) {
                    log.debug(
                        "maintainWinningPosition",
                        "Maintaining winning position",
                        {
                            jobId: job.id,
                            jobRef,
                            currentPriceWei: desiredPrice.toString(),
                            currentPriceEth: formatUnits(desiredPrice, 18),
                        },
                    );
                } else {
                    log.debug(
                        "maintainCappedPosition",
                        "Maintaining capped position",
                        {
                            jobId: job.id,
                            jobRef,
                            currentPriceWei: desiredPrice.toString(),
                            currentPriceEth: formatUnits(desiredPrice, 18),
                            competitorPriceWei: competitorPrice.toString(),
                            competitorPriceEth: formatUnits(
                                competitorPrice,
                                18,
                            ),
                        },
                    );
                }

                return;
            }

            const direction = desiredPrice > myPrice ? "upward" : "downward";
            this.reportDecision(
                job,
                desiredPrice > myPrice
                    ? BIDDER_DECISION.AdjustUp
                    : BIDDER_DECISION.AdjustDown,
            );
            log.info("bidAdjusted", "Adjusting bid", {
                jobId: job.id,
                jobRef,
                direction,
                currentPriceWei: myPrice.toString(),
                currentPriceEth: formatUnits(myPrice, 18),
                desiredPriceWei: desiredPrice.toString(),
                desiredPriceEth: formatUnits(desiredPrice, 18),
                competitorPriceWei: competitorPrice.toString(),
                competitorPriceEth: formatUnits(competitorPrice, 18),
            });
            this.clearRuntimeBidDecision(job);
            await this.placeAndTrack(
                job,
                desiredPrice,
                {
                    competitorPrice,
                    floor,
                    ceiling,
                },
                requestContext,
            );
            await this.cancelMakerOffers(
                job,
                myOffers,
                undefined,
                requestContext,
            );
        } catch (error: unknown) {
            failed = true;
            const { errorMessage, ...errorFields } = toErrorLogFields(error);
            log.error("jobRefreshFailed", "Error refreshing bidding job", {
                jobId,
                errorMessage,
                ...errorFields,
            });
            const job = this.jobs.get(jobId);
            if (job) {
                this.persistJobRuntimeState(job, String(errorMessage));
            }
            if (options.throwOnFailure) {
                throw error;
            }
        } finally {
            if (targetType) {
                const observedTargetType = targetType;
                observeBestEffort(() => {
                    this.observability?.onRefreshFinished({
                        trigger: options.trigger,
                        targetType: observedTargetType,
                        durationMs: Date.now() - startedAt,
                        succeeded: !failed,
                    });
                });
            }
            options.onCompleted?.(!failed);
        }
    }

    private getJobMutex(jobId: string): Mutex {
        let mutex = this.jobMutexes.get(jobId);
        if (!mutex) {
            mutex = new Mutex();
            this.jobMutexes.set(jobId, mutex);
        }

        return mutex;
    }

    private resolveMaxConcurrentJobs(value?: number): number {
        const resolved = value ?? BIDDER_DEFAULT_MAX_CONCURRENT_JOBS;
        if (!Number.isInteger(resolved) || resolved < 1) {
            throw new Error(
                `[Bidder] maxConcurrentJobs must be an integer >= 1. received=${value}`,
            );
        }

        return resolved;
    }

    private scheduleRuntimeOverrideExpiry(
        jobId: string,
        override: RuntimeJobOverride,
    ): ReturnType<typeof setTimeout> {
        return setTimeout(
            () => {
                const currentOverride = this.runtimeOverrides.get(jobId);
                if (
                    !currentOverride ||
                    currentOverride.activationId !== override.activationId
                ) {
                    return;
                }

                this.clearRuntimeOverride(jobId);
                log.info("runtimeOverrideExpired", "Runtime override expired", {
                    jobId,
                    activationId: override.activationId,
                    reason: override.reason ?? "unspecified",
                });

                void this.refreshJobImmediately(jobId, {
                    throwOnFailure: false,
                    trigger: BIDDER_REFRESH_TRIGGER.RuntimeActivation,
                    requestedAt: Date.now(),
                }).catch((error: unknown) => {
                    log.error(
                        "runtimeOverrideExpiryRefreshFailed",
                        "Failed to refresh bidding job after runtime override expiry",
                        {
                            jobId,
                            activationId: override.activationId,
                            ...toErrorLogFields(error),
                        },
                    );
                });
            },
            Math.max(0, override.expiresAt - Date.now()),
        );
    }

    private getRuntimeOverride(jobId: string): RuntimeJobOverride | undefined {
        const override = this.runtimeOverrides.get(jobId);
        if (!override) {
            return undefined;
        }

        if (override.expiresAt <= Date.now()) {
            this.clearRuntimeOverride(jobId);
            return undefined;
        }

        return override;
    }

    private clearRuntimeOverride(jobId: string): void {
        const override = this.runtimeOverrides.get(jobId);
        if (!override) {
            return;
        }

        if (override.timer) {
            clearTimeout(override.timer);
        }
        this.runtimeOverrides.delete(jobId);
    }

    private resolveBootstrapConcurrency(value?: number): number {
        const resolved = value ?? BIDDER_DEFAULT_BOOTSTRAP_CONCURRENCY;
        if (!Number.isInteger(resolved) || resolved < 1) {
            throw new Error(
                `[Bidder] bootstrapConcurrency must be an integer >= 1. received=${value}`,
            );
        }

        return resolved;
    }

    private async evaluateHotRefresh(
        marketEvent: MarketEvent,
    ): Promise<HotRefreshEvaluation[]> {
        const evaluations: HotRefreshEvaluation[] = [];

        for (const job of this.getHotRefreshCandidateJobs(marketEvent)) {
            evaluations.push(await this.evaluateMarketEvent(job, marketEvent));
        }

        return evaluations;
    }

    private getHotRefreshCandidateJobs(marketEvent: MarketEvent): BidderJob[] {
        if (marketEvent.getScope() === Scope.Item) {
            if (!marketEvent.hasExplicitTokenId()) {
                return [];
            }

            const jobId = this.tokenJobIdByCollectionToken.get(
                this.makeCollectionTokenKey(
                    marketEvent.getCollectionSlug(),
                    marketEvent.getItemID(),
                ),
            );
            if (!jobId) {
                return [];
            }

            const job = this.jobs.get(jobId);
            return job ? [job] : [];
        }

        if (
            marketEvent.getScope() === Scope.Collection ||
            marketEvent.getScope() === Scope.Trait
        ) {
            const jobIds = this.tokenJobIdsByCollection.get(
                marketEvent.getCollectionSlug(),
            );
            if (!jobIds) {
                return [];
            }

            return Array.from(jobIds)
                .map((jobId) => this.jobs.get(jobId))
                .filter((job): job is BidderJob => job !== undefined);
        }

        return [];
    }

    private async evaluateMarketEvent(
        job: BidderJob,
        marketEvent: MarketEvent,
    ): Promise<HotRefreshEvaluation> {
        const evaluation: HotRefreshEvaluation = {
            jobId: job.id,
            matched: false,
            reason: "",
            eventType: marketEvent.getType(),
            eventScope: marketEvent.getScope(),
            eventCollectionSlug: marketEvent.getCollectionSlug(),
            eventTokenId: marketEvent.getItemID(),
            eventUnitPrice: marketEvent.getUnitPrice(),
            jobTargetType: job.target.type,
            jobCollectionSlug: job.collectionSlug,
            jobTokenId:
                job.target.type === BIDDER_TARGET_TYPE.Token
                    ? job.target.tokenId
                    : "",
            currentPrice: job.state.currentPrice,
            traitCriteria: marketEvent.getTraitCriteria(),
        };

        if (job.target.type !== BIDDER_TARGET_TYPE.Token) {
            evaluation.reason = "job target is not token";
            return evaluation;
        }

        if (job.collectionSlug !== marketEvent.getCollectionSlug()) {
            evaluation.reason = "collection slug mismatch";
            return evaluation;
        }

        const currentPriceCheck = await this.evaluateCurrentPriceGate(
            job,
            marketEvent,
        );
        evaluation.reason = currentPriceCheck.reason;
        evaluation.currentPrice = currentPriceCheck.currentPrice;
        evaluation.priceDiff = currentPriceCheck.priceDiff;

        if (!currentPriceCheck.shouldReact) {
            return evaluation;
        }

        if (marketEvent.getScope() === Scope.Item) {
            if (!marketEvent.hasExplicitTokenId()) {
                evaluation.reason = "item-scope event has no explicit token id";
                return evaluation;
            }

            if (job.target.tokenId !== marketEvent.getItemID()) {
                evaluation.reason = "item-scope token id mismatch";
                return evaluation;
            }

            evaluation.matched = true;
            evaluation.reason =
                "item-scope token id matched and event price met current price gate";
            return evaluation;
        }

        if (marketEvent.getScope() === Scope.Trait) {
            if (
                !(await this.matchesTraitCriteria(
                    job.collectionSlug,
                    job.target.tokenId,
                    marketEvent.getTraitCriteria(),
                ))
            ) {
                evaluation.reason =
                    "trait criteria did not fully match cached token metadata";
                return evaluation;
            }

            evaluation.matched = true;
            evaluation.reason =
                "trait-scope event fully matched cached token metadata and price gate";
            return evaluation;
        }

        if (marketEvent.getScope() === Scope.Collection) {
            evaluation.matched = true;
            evaluation.reason =
                "collection-scope event matched token job collection and price gate";
            return evaluation;
        }

        evaluation.reason = "unsupported event scope for hot refresh";
        return evaluation;
    }

    private async evaluateCurrentPriceGate(
        job: BidderJob,
        marketEvent: MarketEvent,
    ): Promise<CurrentPriceCheckResult> {
        if (job.state.currentPrice === undefined) {
            return {
                shouldReact: false,
                reason: "currentPrice unavailable",
            };
        }

        const effectiveCeiling = this.getEffectiveCeiling(
            this.getConfiguredCeiling(job),
        );
        if (marketEvent.getUnitPrice() >= effectiveCeiling) {
            return {
                shouldReact: false,
                reason: "event price met or exceeded effective ceiling",
                currentPrice: job.state.currentPrice,
                priceDiff: marketEvent.getUnitPrice() - job.state.currentPrice,
            };
        }

        if (marketEvent.getUnitPrice() < job.state.currentPrice) {
            return {
                shouldReact: false,
                reason: "event price below current price",
                currentPrice: job.state.currentPrice,
                priceDiff: marketEvent.getUnitPrice() - job.state.currentPrice,
            };
        }

        return {
            shouldReact: true,
            reason: "event price met or exceeded current price gate",
            currentPrice: job.state.currentPrice,
            priceDiff: marketEvent.getUnitPrice() - job.state.currentPrice,
        };
    }

    private getConfiguredCeiling(job: BidderJob): bigint {
        return this.getRuntimeOverride(job.id)?.ceiling ?? job.config.ceiling;
    }

    private async tryWarmCurrentPrice(
        job: BidderJob,
        context?: ProgressContext,
    ): Promise<boolean> {
        if (job.target.type !== BIDDER_TARGET_TYPE.Token) {
            return false;
        }

        try {
            const activeOffer = await observeBiddingWork(
                this.observability,
                BIDDING_WORK_STAGE.OrderRecovery,
                () =>
                    this.biddingService.getActiveTokenOfferByMaker(
                        job,
                        this.makerAddress,
                    ),
            );
            if (!activeOffer) {
                return false;
            }

            if (activeOffer.expirationTime === undefined) {
                log.info(
                    "currentPriceWarmSkipped",
                    "Skipping current price warm because active offer expiration is unavailable",
                    {
                        jobId: job.id,
                        jobRef: formatBidderJobReference(job),
                        orderId: activeOffer.id,
                    },
                );
                return false;
            }

            job.state.activeOrderId = activeOffer.id;
            job.state.activeProtocolAddress = activeOffer.protocolAddress;
            job.state.activeOrderPlacedAt = activeOffer.placedAt;
            this.markActiveOrderVerified(job);
            job.state.currentPrice = activeOffer.price;
            job.state.activeExpirationTimeMs = this.toExpirationTimeMs(
                activeOffer.expirationTime,
            );
            const activeExpirationForLog = this.formatExpirationForLog(
                job.state.activeExpirationTimeMs,
            );

            const counter = context
                ? { sequence: context.sequence, total: context.total }
                : {};
            log.debug("currentPriceWarmed", "Warmed current price", {
                jobId: job.id,
                jobRef: formatBidderJobReference(job),
                priceWei: activeOffer.price.toString(),
                priceEth: formatUnits(activeOffer.price, 18),
                orderHash: activeOffer.id,
                protocolAddress: activeOffer.protocolAddress ?? null,
                expiresAt: activeExpirationForLog,
                ...counter,
            });
            this.persistJobRuntimeState(job);
            return true;
        } catch (error: unknown) {
            log.error(
                "currentPriceWarmFailed",
                "Failed to warm current price",
                {
                    jobId: job.id,
                    jobRef: formatBidderJobReference(job),
                    ...toErrorLogFields(error),
                },
            );
            return false;
        }
    }

    private logHotRefreshEffect(evaluation: HotRefreshEvaluation): void {
        log.debug("hotRefreshMatched", "Hot refresh matched bidding job", {
            eventScope: evaluation.eventScope,
            eventTarget: this.formatEventTargetForLog(
                evaluation.eventCollectionSlug,
                evaluation.eventScope,
                evaluation.eventTokenId,
                evaluation.traitCriteria,
            ),
            eventType: evaluation.eventType,
            jobId: evaluation.jobId,
            jobTargetType: evaluation.jobTargetType,
            jobTokenId: evaluation.jobTokenId || null,
            reason: evaluation.reason,
            eventPriceWei: evaluation.eventUnitPrice.toString(),
            eventPriceEth: formatUnits(evaluation.eventUnitPrice, 18),
            currentPrice: this.formatOptionalPriceForLog(
                evaluation.currentPrice,
            ),
            priceDiff: this.formatSignedPriceForLog(evaluation.priceDiff),
        });
    }

    private logNoEffectHotRefresh(
        marketEvent: MarketEvent,
        evaluations: HotRefreshEvaluation[],
    ): void {
        const reasonSummary = this.summarizeNoEffectReasons(
            marketEvent,
            evaluations,
        );
        const eventTarget = this.formatEventTargetForLog(
            marketEvent.getCollectionSlug(),
            marketEvent.getScope(),
            marketEvent.getItemID(),
            marketEvent.getTraitCriteria(),
        );
        const summaryKey = this.makeNoEffectLogSummaryKey(
            marketEvent,
            reasonSummary,
        );
        const now = Date.now();
        const existingSummary =
            this.hotRefreshNoEffectLogSummaries.get(summaryKey);
        if (
            existingSummary &&
            now - existingSummary.lastLoggedAt <
                BIDDER_HOT_REFRESH_NO_EFFECT_LOG_INTERVAL_MS
        ) {
            existingSummary.suppressedCount += 1;
            if (
                marketEvent.getUnitPrice() > existingSummary.maxEventUnitPrice
            ) {
                existingSummary.maxEventUnitPrice = marketEvent.getUnitPrice();
                existingSummary.sampleEventTarget = eventTarget;
            }
            return;
        }

        const suppressedCount = existingSummary?.suppressedCount ?? 0;
        const maxEventUnitPrice =
            existingSummary &&
            existingSummary.maxEventUnitPrice > marketEvent.getUnitPrice()
                ? existingSummary.maxEventUnitPrice
                : marketEvent.getUnitPrice();
        const sampleEventTarget =
            existingSummary &&
            existingSummary.maxEventUnitPrice > marketEvent.getUnitPrice()
                ? existingSummary.sampleEventTarget
                : eventTarget;

        log.debug(
            "hotRefreshNoEffect",
            "Hot refresh had no matching bidding job",
            {
                eventScope: marketEvent.getScope(),
                eventTarget,
                sampleEventTarget,
                eventType: marketEvent.getType(),
                eventPriceWei: marketEvent.getUnitPrice().toString(),
                eventPrice: formatUnits(
                    marketEvent.getUnitPrice(),
                    marketEvent.getPaymentTokenDecimals(),
                ),
                maxEventPriceWei: maxEventUnitPrice.toString(),
                maxEventPrice: formatUnits(
                    maxEventUnitPrice,
                    marketEvent.getPaymentTokenDecimals(),
                ),
                candidateCount: evaluations.length,
                eventCount: suppressedCount + 1,
                suppressedEventCount: suppressedCount,
                summaryIntervalMs: BIDDER_HOT_REFRESH_NO_EFFECT_LOG_INTERVAL_MS,
                reasons: reasonSummary,
            },
        );
        this.hotRefreshNoEffectLogSummaries.set(summaryKey, {
            lastLoggedAt: now,
            suppressedCount: 0,
            maxEventUnitPrice: marketEvent.getUnitPrice(),
            sampleEventTarget: eventTarget,
        });
    }

    private summarizeNoEffectReasons(
        marketEvent: MarketEvent,
        evaluations: HotRefreshEvaluation[],
    ): string {
        const reasons = new Map<string, number>();

        evaluations.forEach((evaluation) => {
            reasons.set(
                evaluation.reason,
                (reasons.get(evaluation.reason) ?? 0) + 1,
            );
        });

        const reasonSummary = Array.from(reasons.entries())
            .map(([reason, count]) => `${reason}=${count}`)
            .join("; ");

        return reasonSummary || this.describeNoCandidateReason(marketEvent);
    }

    private makeNoEffectLogSummaryKey(
        marketEvent: MarketEvent,
        reasonSummary: string,
    ): string {
        return [
            marketEvent.getCollectionSlug(),
            marketEvent.getScope(),
            marketEvent.getType(),
            reasonSummary,
        ].join("|");
    }

    private formatPriceForLog(value: bigint, decimals: number = 18): string {
        return `${formatUnits(value, decimals)} (${value.toString()} raw)`;
    }

    private formatOptionalPriceForLog(
        value: bigint | undefined,
        decimals: number = 18,
    ): string {
        if (value === undefined) {
            return "none";
        }
        return this.formatPriceForLog(value, decimals);
    }

    private formatSignedPriceForLog(
        value: bigint | undefined,
        decimals: number = 18,
    ): string {
        if (value === undefined) {
            return "none";
        }

        const sign = value < 0n ? "-" : "+";
        const absValue = value < 0n ? -value : value;
        return `${sign}${formatUnits(absValue, decimals)} (${value.toString()} raw)`;
    }

    private formatTraitCriteriaForLog(criteria: TraitCriterion[]): string {
        if (criteria.length === 0) {
            return "none";
        }

        return criteria
            .map((criterion) => `${criterion.type}=${criterion.value}`)
            .join("|");
    }

    private async refreshCachedMakerWethBalance(): Promise<boolean> {
        if (!this.makerWethBalanceService) {
            return false;
        }

        try {
            this.cachedMakerWethBalance = await observeBiddingWork(
                this.observability,
                BIDDING_WORK_STAGE.BalanceRead,
                () =>
                    this.makerWethBalanceService!.getWethBalance(
                        this.makerAddress,
                    ),
            );
            return true;
        } catch (error: unknown) {
            log.error(
                "makerWethBalanceRefreshFailed",
                "Failed to refresh maker WETH balance",
                {
                    makerAddress: this.makerAddress,
                    ...toErrorLogFields(error),
                },
            );
            return false;
        }
    }

    private getEffectiveCeiling(configuredCeiling: bigint): bigint {
        if (this.cachedMakerWethBalance === undefined) {
            return configuredCeiling;
        }

        return this.cachedMakerWethBalance < configuredCeiling
            ? this.cachedMakerWethBalance
            : configuredCeiling;
    }

    private getEffectiveFloor(configuredFloor: bigint): bigint {
        if (this.cachedMakerWethBalance === undefined) {
            return configuredFloor;
        }

        return this.cachedMakerWethBalance < configuredFloor
            ? this.cachedMakerWethBalance
            : configuredFloor;
    }

    private getDesiredBid(
        floor: bigint,
        ceiling: bigint,
        competitorPrice: bigint,
        delta: bigint,
    ): bigint {
        let desiredPrice = competitorPrice + delta;
        if (desiredPrice < floor) {
            desiredPrice = floor;
        }
        if (desiredPrice > ceiling) {
            desiredPrice = ceiling;
        }

        return desiredPrice;
    }

    private formatScanBalanceForLog(): string {
        if (this.cachedMakerWethBalance === undefined) {
            return "unavailable";
        }

        return `${this.formatFixedEthUnits(this.cachedMakerWethBalance, 3)} WETH`;
    }

    private formatFixedEthUnits(value: bigint, precision: number): string {
        const base = 10n ** 18n;
        const scale = 10n ** BigInt(precision);
        const whole = value / base;
        const fraction = ((value % base) * scale) / base;

        return `${whole.toString()}.${fraction.toString().padStart(precision, "0")}`;
    }

    private formatEventTargetForLog(
        collectionSlug: string,
        scope: Scope,
        tokenId: string,
        traitCriteria: TraitCriterion[],
    ): string {
        if (scope === Scope.Item) {
            return `${collectionSlug}#${tokenId || "?"}`;
        }

        if (scope === Scope.Trait) {
            return `${collectionSlug}[${this.formatTraitCriteriaForLog(traitCriteria)}]`;
        }

        if (scope === Scope.Collection) {
            return `${collectionSlug}/*`;
        }

        return `${collectionSlug}/${tokenId || "*"}`;
    }

    private describeNoCandidateReason(marketEvent: MarketEvent): string {
        if (marketEvent.getScope() === Scope.Item) {
            if (!marketEvent.hasExplicitTokenId()) {
                return "item event missing explicit token id";
            }
            return "no indexed token job candidate";
        }

        if (
            marketEvent.getScope() === Scope.Collection ||
            marketEvent.getScope() === Scope.Trait
        ) {
            return "no indexed token jobs for collection";
        }

        return "unsupported event scope";
    }

    private addJobToIndexes(job: BidderJob): void {
        if (job.target.type !== BIDDER_TARGET_TYPE.Token) {
            return;
        }

        const collectionTokenKey = this.makeCollectionTokenKey(
            job.collectionSlug,
            job.target.tokenId,
        );
        const existingJobId =
            this.tokenJobIdByCollectionToken.get(collectionTokenKey);
        if (existingJobId && existingJobId !== job.id) {
            throw new Error(
                `[Bidder] Duplicate token job detected for ${formatBidderJobReference(job)}: existingJobId=${existingJobId}`,
            );
        }

        this.tokenJobIdByCollectionToken.set(collectionTokenKey, job.id);

        if (!this.tokenJobIdsByCollection.has(job.collectionSlug)) {
            this.tokenJobIdsByCollection.set(job.collectionSlug, new Set());
        }
        this.tokenJobIdsByCollection.get(job.collectionSlug)!.add(job.id);
    }

    private removeJobFromIndexes(job: BidderJob): void {
        if (job.target.type !== BIDDER_TARGET_TYPE.Token) {
            return;
        }

        const collectionTokenKey = this.makeCollectionTokenKey(
            job.collectionSlug,
            job.target.tokenId,
        );
        if (
            this.tokenJobIdByCollectionToken.get(collectionTokenKey) === job.id
        ) {
            this.tokenJobIdByCollectionToken.delete(collectionTokenKey);
        }

        const collectionJobIds = this.tokenJobIdsByCollection.get(
            job.collectionSlug,
        );
        if (!collectionJobIds) {
            return;
        }

        collectionJobIds.delete(job.id);
        if (collectionJobIds.size === 0) {
            this.tokenJobIdsByCollection.delete(job.collectionSlug);
        }
    }

    private makeCollectionTokenKey(
        collectionSlug: string,
        tokenId: string,
    ): string {
        return `${collectionSlug}:${tokenId}`;
    }

    private async matchesTraitCriteria(
        collectionSlug: string,
        tokenId: string,
        traitCriteria: TraitCriterion[],
    ): Promise<boolean> {
        if (traitCriteria.length === 0 || !this.tokenMetadataRepository) {
            return false;
        }

        const tokenTraits = await this.tokenMetadataRepository.getTraits(
            collectionSlug,
            tokenId,
        );
        if (tokenTraits.length === 0) {
            return false;
        }

        return traitCriteria.every((criterion) => {
            return tokenTraits.some((tokenTrait) => {
                return (
                    tokenTrait.type === criterion.type &&
                    tokenTrait.value === criterion.value
                );
            });
        });
    }

    private normalizeOrderTraitTargets(order: Order): TraitCriterion[] {
        return normalizeOpenSeaOfferTraitCriteria(
            getOpenSeaOfferCriteria(order.rawOrder),
        );
    }

    private dedupeTraitTargets(targets: TraitCriterion[]): TraitCriterion[] {
        const seen = new Set<string>();
        return targets.filter((target) => {
            const key = `${target.type}|${target.value}`;
            if (seen.has(key)) {
                return false;
            }
            seen.add(key);
            return true;
        });
    }

    private matchesExactTraitTargets(
        left: TraitCriterion[],
        right: TraitCriterion[],
    ): boolean {
        const normalizedLeft = this.dedupeTraitTargets(left);
        const normalizedRight = this.dedupeTraitTargets(right);

        if (normalizedLeft.length !== normalizedRight.length) {
            return false;
        }

        const rightKeys = new Set(
            normalizedRight.map((target) => `${target.type}|${target.value}`),
        );
        return normalizedLeft.every((target) =>
            rightKeys.has(`${target.type}|${target.value}`),
        );
    }

    private isOfferManagedByJob(job: BidderJob, order: Order): boolean {
        if (job.target.type === BIDDER_TARGET_TYPE.Token) {
            return order.offerScope === "item";
        }

        if (job.target.type === BIDDER_TARGET_TYPE.Collection) {
            const targetTraits = job.target.traits ?? [];
            if (targetTraits.length === 0) {
                return order.offerScope === "collection";
            }

            if (order.offerScope !== "trait") {
                return false;
            }

            return this.matchesExactTraitTargets(
                this.normalizeOrderTraitTargets(order),
                targetTraits,
            );
        }

        if (job.target.type === BIDDER_TARGET_TYPE.CompetitiveTrait) {
            if (order.offerScope !== "trait") {
                return false;
            }

            return this.matchesExactTraitTargets(
                this.normalizeOrderTraitTargets(order),
                [job.target.targetTrait],
            );
        }

        return false;
    }

    private async placeAndTrack(
        job: BidderJob,
        amount: bigint,
        decisionContext?: RuntimeBidDecisionContext,
        requestContext: BiddingServiceRequestContext = {},
    ): Promise<void> {
        const startedAt = Date.now();
        let failed = false;
        try {
            await observeBiddingWork(
                this.observability,
                BIDDING_WORK_STAGE.PlaceOffer,
                () =>
                    this.performPlaceAndTrack(
                        job,
                        amount,
                        decisionContext,
                        requestContext,
                    ),
            );
        } catch (error: unknown) {
            failed = true;
            throw error;
        } finally {
            observeBestEffort(() => {
                this.observability?.onMarketActionFinished({
                    action: BIDDER_MARKET_ACTION.PlaceOffer,
                    targetType: job.target.type,
                    dryRun: this.isDryRun(),
                    durationMs: Date.now() - startedAt,
                    succeeded: !failed,
                });
            });
        }
    }

    private async performPlaceAndTrack(
        job: BidderJob,
        amount: bigint,
        decisionContext?: RuntimeBidDecisionContext,
        requestContext: BiddingServiceRequestContext = {},
    ): Promise<void> {
        job.state.lastRun = Date.now();
        const jobRef = formatBidderJobReference(job);

        if (this.isDryRun()) {
            if (
                job.target.type === BIDDER_TARGET_TYPE.Collection ||
                job.target.type === BIDDER_TARGET_TYPE.CompetitiveTrait
            ) {
                const qty = Math.max(1, Math.floor(job.target.quantity));
                const totalWei = amount * BigInt(qty);
                log.info(
                    "dryRunCollectionOfferPlace",
                    "Dry run would place collection offer",
                    {
                        jobId: job.id,
                        jobRef,
                        unitPriceWei: amount.toString(),
                        unitPriceEth: formatUnits(amount, 18),
                        quantity: qty,
                        totalPriceWei: totalWei.toString(),
                        totalPriceEth: formatUnits(totalWei, 18),
                    },
                );
            } else {
                log.info("dryRunOfferPlace", "Dry run would place offer", {
                    jobId: job.id,
                    jobRef,
                    priceWei: amount.toString(),
                    priceEth: formatUnits(amount, 18),
                });
            }
            return;
        }

        const { orderHash, protocolAddress, placedAt, expirationTime } =
            await this.biddingService.placeOffer(job, amount, requestContext);
        job.state.activeOrderId = orderHash;
        job.state.activeProtocolAddress = protocolAddress;
        job.state.activeOrderPlacedAt = placedAt;
        this.markActiveOrderVerified(job);
        job.state.currentPrice = amount;
        job.state.activeExpirationTimeMs =
            this.toExpirationTimeMs(expirationTime);
        if (decisionContext) {
            this.trackRuntimeBidDecision(
                job,
                amount,
                decisionContext.competitorPrice,
                decisionContext.floor,
                decisionContext.ceiling,
            );
        }
        this.persistJobRuntimeState(job, null, { required: true });
        if (
            job.target.type === BIDDER_TARGET_TYPE.Collection ||
            job.target.type === BIDDER_TARGET_TYPE.CompetitiveTrait
        ) {
            const qty = Math.max(1, Math.floor(job.target.quantity));
            const totalWei = amount * BigInt(qty);
            log.info("collectionOfferPlaced", "Placed collection offer", {
                jobId: job.id,
                jobRef,
                unitPriceWei: amount.toString(),
                unitPriceEth: formatUnits(amount, 18),
                quantity: qty,
                totalPriceWei: totalWei.toString(),
                totalPriceEth: formatUnits(totalWei, 18),
                orderHash,
                protocolAddress,
                expiresAt: this.formatExpirationForLog(
                    job.state.activeExpirationTimeMs,
                ),
            });
        } else {
            log.info("offerPlaced", "Placed offer", {
                jobId: job.id,
                jobRef,
                priceWei: amount.toString(),
                priceEth: formatUnits(amount, 18),
                orderHash,
                protocolAddress,
                expiresAt: this.formatExpirationForLog(
                    job.state.activeExpirationTimeMs,
                ),
            });
        }
    }

    private async cancelAndTrack(
        job: BidderJob,
        order: Order,
        requestContext: BiddingServiceRequestContext = {},
    ): Promise<void> {
        const startedAt = Date.now();
        let failed = false;
        try {
            await observeBiddingWork(
                this.observability,
                BIDDING_WORK_STAGE.CancelOffer,
                () => this.performCancelAndTrack(job, order, requestContext),
            );
        } catch (error: unknown) {
            failed = true;
            throw error;
        } finally {
            observeBestEffort(() => {
                this.observability?.onMarketActionFinished({
                    action: BIDDER_MARKET_ACTION.CancelOffer,
                    targetType: job.target.type,
                    dryRun: this.isDryRun(),
                    durationMs: Date.now() - startedAt,
                    succeeded: !failed,
                });
            });
        }
    }

    private async performCancelAndTrack(
        job: BidderJob,
        order: Order,
        requestContext: BiddingServiceRequestContext = {},
    ): Promise<void> {
        const jobRef = formatBidderJobReference(job);
        if (this.isDryRun()) {
            log.info("dryRunOfferCancel", "Dry run would cancel offer", {
                jobId: job.id,
                jobRef,
                orderId: order.id,
            });
            return;
        }

        log.info("offerCancelStarted", "Cancelling offer", {
            jobId: job.id,
            jobRef,
            orderId: order.id,
            offerScope: order.offerScope ?? null,
            priceWei: order.price.toString(),
            priceEth: formatUnits(order.price, 18),
            priceSource: order.priceSource ?? order.source ?? null,
            quantity: order.quantity?.toString() ?? "1",
        });
        const requestedAt = new Date().toISOString();
        this.recordJobOfferCancellation(job, order, {
            requestedAt,
            completedAt: null,
            cancellationError: null,
        });
        try {
            await this.biddingService.cancelOffer(job, order, requestContext);
        } catch (error: unknown) {
            this.recordJobOfferCancellation(job, order, {
                requestedAt,
                completedAt: null,
                cancellationError:
                    error instanceof Error ? error.message : String(error),
            });
            throw error;
        }
        this.recordJobOfferCancellation(job, order, {
            requestedAt,
            completedAt: new Date().toISOString(),
            cancellationError: null,
        });
        log.info("offerCancelCompleted", "Cancelled offer", {
            jobId: job.id,
            jobRef,
            orderId: order.id,
        });
    }

    private trackCurrentOrder(job: BidderJob, order: Order): void {
        const nextExpirationTimeMs =
            this.toExpirationTimeMs(order.expirationTime) ??
            (job.state.activeOrderId === order.id
                ? job.state.activeExpirationTimeMs
                : undefined);
        const nextPlacedAt =
            order.placedAt ??
            (job.state.activeOrderId === order.id
                ? job.state.activeOrderPlacedAt
                : undefined);

        job.state.activeOrderId = order.id;
        job.state.activeProtocolAddress = order.protocolAddress;
        job.state.activeOrderPlacedAt = nextPlacedAt;
        this.markActiveOrderVerified(job);
        job.state.currentPrice = order.price;
        job.state.activeExpirationTimeMs = nextExpirationTimeMs;
        this.persistJobRuntimeState(job);
    }

    private clearTrackedOrder(job: BidderJob): void {
        job.state.activeOrderId = undefined;
        job.state.activeProtocolAddress = undefined;
        job.state.activeOrderPlacedAt = undefined;
        job.state.activeOrderVerifiedAt = undefined;
        job.state.currentPrice = undefined;
        job.state.activeExpirationTimeMs = undefined;
        this.clearRuntimeBidDecision(job);
        this.persistJobRuntimeState(job);
    }

    private async resolveTrackedActiveOrder(
        job: BidderJob,
        offers: Order[],
        jobRef: string,
        clearMissing: boolean,
        requestContext: BiddingServiceRequestContext = {},
    ): Promise<Order | null> {
        const activeId = job.state.activeOrderId;
        if (!activeId) {
            return null;
        }

        const foundInMarket = offers.find((offer) => offer.id === activeId);
        if (foundInMarket) {
            if (
                !job.state.activeProtocolAddress &&
                foundInMarket.protocolAddress
            ) {
                job.state.activeProtocolAddress = foundInMarket.protocolAddress;
            }
            return foundInMarket;
        }

        log.debug(
            "activeBidMissingFromMarket",
            "Tracked active bid was not found in market offers; checking directly",
            {
                jobId: job.id,
                jobRef,
                orderId: activeId,
            },
        );
        const tokenId =
            job.target.type === BIDDER_TARGET_TYPE.Token
                ? job.target.tokenId
                : undefined;
        const recovered = await observeBiddingWork(
            this.observability,
            BIDDING_WORK_STAGE.OrderRecovery,
            () =>
                this.biddingService.getOrder(
                    activeId,
                    job.state.activeProtocolAddress,
                    job.collectionAddress,
                    tokenId,
                    job.collectionSlug,
                    requestContext,
                ),
        );

        if (recovered.status === BIDDING_ORDER_RECOVERY_STATUS.Active) {
            log.info(
                "activeBidRecovered",
                "Recovered active bid from tracked state",
                {
                    jobId: job.id,
                    jobRef,
                    orderId: activeId,
                    protocolAddress: recovered.order.protocolAddress ?? null,
                },
            );
            if (
                !job.state.activeProtocolAddress &&
                recovered.order.protocolAddress
            ) {
                job.state.activeProtocolAddress =
                    recovered.order.protocolAddress;
            }
            return recovered.order;
        }

        if (recovered.status === BIDDING_ORDER_RECOVERY_STATUS.Inconclusive) {
            throw new Error(
                `[Bidder] Unable to prove tracked active order status: jobId=${job.id}, orderId=${activeId}, reason=${recovered.reason}`,
            );
        }

        if (clearMissing) {
            log.info(
                "activeBidInvalid",
                "Tracked active bid is invalid or missing; clearing state",
                {
                    jobId: job.id,
                    jobRef,
                    orderId: activeId,
                },
            );
            this.clearTrackedOrder(job);
        }
        return null;
    }

    private reportDecision(job: BidderJob, decision: BidderDecision): void {
        observeBestEffort(() =>
            this.observability?.onDecision?.({
                decision,
                targetType: job.target.type,
                dryRun: this.isDryRun(),
            }),
        );
    }

    private readActiveOffers(
        job: BidderJob,
        context: BiddingServiceRequestContext,
    ): Promise<Order[]> {
        return observeBiddingWork(
            this.observability,
            BIDDING_WORK_STAGE.MarketRead,
            () => this.biddingService.getActiveOffers(job, context),
        );
    }

    private persistJobRuntimeState(
        job: BidderJob,
        lastError: string | null = null,
        options: { required?: boolean } = {},
    ): void {
        if (!this.runtimeStatePort) {
            return;
        }

        const snapshot: BiddingJobRuntimeStateSnapshot = {
            jobId: job.id,
            jobRevision: job.revision,
            currentPriceWei: job.state.currentPrice?.toString() ?? null,
            activeOrderId: job.state.activeOrderId ?? null,
            activeProtocolAddress: job.state.activeProtocolAddress ?? null,
            activeOrderPlacedAt: job.state.activeOrderPlacedAt ?? null,
            activeOrderVerifiedAt: job.state.activeOrderVerifiedAt ?? null,
            activeExpirationTimeMs: job.state.activeExpirationTimeMs ?? null,
            bidPosition: job.state.bidPosition ?? null,
            bidConstraints: job.state.bidConstraints ?? [],
            competitorPriceWei: job.state.competitorPrice?.toString() ?? null,
            lastRunAt: job.state.lastRun
                ? new Date(job.state.lastRun).toISOString()
                : null,
            lastError,
        };

        try {
            // Persist runtime feedback for backend read models without changing bidder decisions if SQLite is unavailable.
            this.runtimeStatePort.persistJobRuntimeState(snapshot);
        } catch (error: unknown) {
            log.error(
                BIDDER_LOG_ACTION.RuntimeStatePersistFailed,
                "Failed to persist bidding job runtime state",
                {
                    jobId: job.id,
                    jobRef: formatBidderJobReference(job),
                    ...toErrorLogFields(error),
                },
            );
            if (options.required) {
                throw error;
            }
        }
    }

    private markActiveOrderVerified(job: BidderJob): void {
        job.state.activeOrderVerifiedAt = new Date().toISOString();
    }

    private recordJobOfferCancellation(
        job: BidderJob,
        order: Order,
        state: {
            requestedAt: string;
            completedAt: string | null;
            cancellationError: string | null;
        },
    ): void {
        if (!this.runtimeStatePort) {
            return;
        }

        try {
            // Persist own-order cancellation facts so read models can hide stale marketplace index rows.
            this.runtimeStatePort.recordJobOfferCancellation({
                jobId: job.id,
                jobRevision: job.revision,
                orderId: order.id,
                priceWei: order.price.toString(),
                protocolAddress: order.protocolAddress ?? null,
                placedAt: order.placedAt ?? null,
                expirationTimeMs:
                    this.toExpirationTimeMs(order.expirationTime) ?? null,
                makerAddress: this.makerAddress.toLowerCase(),
                requestedAt: state.requestedAt,
                completedAt: state.completedAt,
                cancellationError: state.cancellationError,
            });
        } catch (error: unknown) {
            log.error(
                BIDDER_LOG_ACTION.OfferCancellationPersistFailed,
                "Failed to persist bidding offer cancellation state",
                {
                    jobId: job.id,
                    jobRef: formatBidderJobReference(job),
                    orderId: order.id,
                    ...toErrorLogFields(error),
                },
            );
        }
    }

    private recordTrackedOrderCancellation(
        job: BidderJob,
        state: {
            requestedAt: string;
            completedAt: string | null;
            cancellationError: string | null;
        },
    ): void {
        if (!this.runtimeStatePort || !job.state.activeOrderId) {
            return;
        }

        try {
            // Settle a tracked order that OpenSea already reports absent from active offers.
            this.runtimeStatePort.recordJobOfferCancellation({
                jobId: job.id,
                jobRevision: job.revision,
                orderId: job.state.activeOrderId,
                priceWei: job.state.currentPrice?.toString() ?? null,
                protocolAddress: job.state.activeProtocolAddress ?? null,
                placedAt: job.state.activeOrderPlacedAt ?? null,
                expirationTimeMs: job.state.activeExpirationTimeMs ?? null,
                makerAddress: this.makerAddress.toLowerCase(),
                requestedAt: state.requestedAt,
                completedAt: state.completedAt,
                cancellationError: state.cancellationError,
            });
        } catch (error: unknown) {
            log.error(
                BIDDER_LOG_ACTION.OfferCancellationPersistFailed,
                "Failed to persist bidding offer cancellation state",
                {
                    jobId: job.id,
                    jobRef: formatBidderJobReference(job),
                    orderId: job.state.activeOrderId,
                    ...toErrorLogFields(error),
                },
            );
        }
    }

    private trackRuntimeBidDecision(
        job: BidderJob,
        ownPrice: bigint,
        competitorPrice: bigint,
        floor: bigint,
        ceiling: bigint,
    ): void {
        const position = this.resolveRuntimeBidPosition(
            ownPrice,
            competitorPrice,
        );
        job.state.bidPosition = position;
        job.state.bidConstraints = this.resolveRuntimeBidConstraints(
            position,
            ownPrice,
            floor,
            ceiling,
        );
        job.state.competitorPrice = competitorPrice;
    }

    private clearRuntimeBidDecision(job: BidderJob): void {
        job.state.bidPosition = undefined;
        job.state.bidConstraints = undefined;
        job.state.competitorPrice = undefined;
    }

    private resolveRuntimeBidPosition(
        ownPrice: bigint,
        competitorPrice: bigint,
    ): TradingBiddingJobRuntimeBidPosition {
        if (ownPrice > competitorPrice) {
            return TRADING_BIDDING_JOB_RUNTIME_BID_POSITION.Winning;
        }
        if (ownPrice === competitorPrice) {
            return TRADING_BIDDING_JOB_RUNTIME_BID_POSITION.Draw;
        }
        return TRADING_BIDDING_JOB_RUNTIME_BID_POSITION.Losing;
    }

    private resolveRuntimeBidConstraints(
        position: TradingBiddingJobRuntimeBidPosition,
        ownPrice: bigint,
        floor: bigint,
        ceiling: bigint,
    ): TradingBiddingJobRuntimeConstraint[] {
        const isAtCeiling = ceiling > 0n && ownPrice >= ceiling;
        const isAtFloor = floor > 0n && ownPrice <= floor;

        if (
            position !== TRADING_BIDDING_JOB_RUNTIME_BID_POSITION.Winning &&
            isAtCeiling
        ) {
            return [TRADING_BIDDING_JOB_RUNTIME_CONSTRAINT.Ceiling];
        }

        if (isAtFloor) {
            return [TRADING_BIDDING_JOB_RUNTIME_CONSTRAINT.Floor];
        }

        return isAtCeiling
            ? [TRADING_BIDDING_JOB_RUNTIME_CONSTRAINT.Ceiling]
            : [];
    }

    private async cancelMakerOffers(
        job: BidderJob,
        myOffers: Order[],
        keepOrderId?: string,
        requestContext: BiddingServiceRequestContext = {},
    ): Promise<void> {
        for (const offer of myOffers) {
            if (keepOrderId && offer.id === keepOrderId) {
                continue;
            }

            await this.cancelAndTrack(job, offer, requestContext);
        }
    }

    private hasSameTargetIdentity(
        existingJob: BidderJob,
        nextJob: BidderJob,
    ): boolean {
        if (
            existingJob.collectionAddress !== nextJob.collectionAddress ||
            existingJob.collectionSlug !== nextJob.collectionSlug ||
            existingJob.target.type !== nextJob.target.type
        ) {
            return false;
        }

        if (
            existingJob.target.type === BIDDER_TARGET_TYPE.Token &&
            nextJob.target.type === BIDDER_TARGET_TYPE.Token
        ) {
            return existingJob.target.tokenId === nextJob.target.tokenId;
        }

        if (
            existingJob.target.type === BIDDER_TARGET_TYPE.Collection &&
            nextJob.target.type === BIDDER_TARGET_TYPE.Collection
        ) {
            return this.matchesExactTraitTargets(
                existingJob.target.traits ?? [],
                nextJob.target.traits ?? [],
            );
        }

        if (
            existingJob.target.type === BIDDER_TARGET_TYPE.CompetitiveTrait &&
            nextJob.target.type === BIDDER_TARGET_TYPE.CompetitiveTrait
        ) {
            return this.matchesExactTraitTargets(
                [existingJob.target.targetTrait],
                [nextJob.target.targetTrait],
            );
        }

        return false;
    }

    private hasSameSatisfiedDeclaration(
        currentJob: BidderJob,
        desiredJob: BidderJob,
    ): boolean {
        return (
            currentJob.revision === desiredJob.revision &&
            currentJob.config.floor === desiredJob.config.floor &&
            currentJob.config.ceiling === desiredJob.config.ceiling &&
            currentJob.config.delta === desiredJob.config.delta &&
            this.hasSameTargetIdentity(currentJob, desiredJob)
        );
    }

    private getBidRenewalReason(
        job: BidderJob,
        order: Order,
    ): string | undefined {
        const expirationTimeMs = this.resolveKnownExpirationTimeMs(job, order);
        if (expirationTimeMs === undefined) {
            return "expiration unknown";
        }

        const remainingMs = expirationTimeMs - Date.now();
        const renewalWindowMs = this.scanSleepMs * 2;
        if (remainingMs >= renewalWindowMs) {
            return undefined;
        }

        return `expiration within renewal window (remainingMs=${remainingMs}, renewalWindowMs=${renewalWindowMs})`;
    }

    private resolveKnownExpirationTimeMs(
        job: BidderJob,
        order: Order,
    ): number | undefined {
        return (
            this.toExpirationTimeMs(order.expirationTime) ??
            (job.state.activeOrderId === order.id
                ? job.state.activeExpirationTimeMs
                : undefined)
        );
    }

    private toExpirationTimeMs(expirationTime?: number): number | undefined {
        if (
            expirationTime === undefined ||
            !Number.isFinite(expirationTime) ||
            expirationTime <= 0
        ) {
            return undefined;
        }

        return Math.floor(expirationTime * 1000);
    }

    private formatExpirationForLog(expirationTimeMs?: number): string {
        if (expirationTimeMs === undefined) {
            return "unknown";
        }

        return new Date(expirationTimeMs).toISOString();
    }
}
