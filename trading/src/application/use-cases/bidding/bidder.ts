import { Mutex, Semaphore } from "async-mutex";
import { formatUnits } from "viem";
import {
    TRADING_BIDDING_JOB_RUNTIME_BID_POSITION,
    TRADING_BIDDING_JOB_RUNTIME_CONSTRAINT,
    type TradingBiddingJobRuntimeBidPosition,
    type TradingBiddingJobRuntimeConstraint,
} from "@artgod/shared/types";
import {
    MarketEvent,
    Scope,
    TraitCriterion,
} from "../../../domain/market/event.js";
import { TokenMetadataRepository } from "../../../domain/market/token-metadata-repository.js";
import {
    BidderJob,
    formatBidderJobReference,
} from "../../../domain/market/strategy/job.js";
import {
    BIDDING_LOG_COMPONENT,
    createBiddingComponentLogger,
    toErrorLogFields,
} from "../../../utils/bidding-log.js";
import { sleep } from "../../../utils/sleep.js";
import {
    BIDDER_DEFAULT_BOOTSTRAP_CONCURRENCY,
    BIDDER_DEFAULT_MAX_CONCURRENT_JOBS,
} from "./defaults.js";
import { BiddingService, Order } from "./bidding-service.js";
import { MakerWethBalanceService } from "./maker-weth-balance-service.js";

export interface BidderOptions {
    dryRun?: boolean;
    maxConcurrentJobs?: number;
    bootstrapConcurrency?: number;
}

export type BiddingJobRuntimeStateSnapshot = {
    jobId: string;
    currentPriceWei: string | null;
    activeOrderId: string | null;
    activeProtocolAddress: string | null;
    activeExpirationTimeMs: number | null;
    bidPosition: TradingBiddingJobRuntimeBidPosition | null;
    bidConstraints: TradingBiddingJobRuntimeConstraint[];
    competitorPriceWei: string | null;
    lastRunAt: string | null;
    lastError: string | null;
};

export interface BiddingJobRuntimeStatePort {
    persistJobRuntimeState(
        snapshot: BiddingJobRuntimeStateSnapshot,
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
}

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

// Bidder is the pure bidding core ported from the production bot with mechanical renames only.
export class Bidder implements BidderRefreshPort, BidderActivationPort {
    private readonly jobs = new Map<string, BidderJob>();
    private readonly tokenJobIdByCollectionToken = new Map<string, string>();
    private readonly tokenJobIdsByCollection = new Map<string, Set<string>>();
    private readonly jobExecutionStates = new Map<string, JobExecutionState>();
    private readonly jobMutexes = new Map<string, Mutex>();
    private readonly runtimeOverrides = new Map<string, RuntimeJobOverride>();
    private cachedMakerWethBalance?: bigint;
    private readonly jobExecutionSemaphore: Semaphore;
    private readonly maxConcurrentJobs: number;
    private readonly bootstrapConcurrency: number;
    private nextActivationId = 1;
    private started = false;
    private pollTimer?: ReturnType<typeof setTimeout>;

    constructor(
        private readonly biddingService: BiddingService,
        private readonly makerAddress: string,
        private readonly pollIntervalMs: number,
        private readonly options: BidderOptions = {},
        private readonly tokenMetadataRepository?: TokenMetadataRepository,
        private readonly makerWethBalanceService?: MakerWethBalanceService,
        private readonly runtimeStatePort?: BiddingJobRuntimeStatePort,
    ) {
        this.maxConcurrentJobs = this.resolveMaxConcurrentJobs(
            options.maxConcurrentJobs,
        );
        this.bootstrapConcurrency = this.resolveBootstrapConcurrency(
            options.bootstrapConcurrency,
        );
        this.jobExecutionSemaphore = new Semaphore(this.maxConcurrentJobs);
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
        }

        this.jobs.set(job.id, job);
        this.addJobToIndexes(job);
    }

    public getJob(jobId: string): BidderJob | undefined {
        return this.jobs.get(jobId);
    }

    public removeJob(jobId: string): BidderJob | undefined {
        const existingJob = this.jobs.get(jobId);
        if (!existingJob) {
            return undefined;
        }

        this.clearRuntimeOverride(jobId);
        this.removeJobFromIndexes(existingJob);
        this.jobs.delete(jobId);
        return existingJob;
    }

    public async cancelActiveOffersForJob(job: BidderJob): Promise<number> {
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
            const offers = await this.biddingService.getActiveOffers(job);
            const makerAddress = this.makerAddress.toLowerCase();
            const makerOffers = offers.filter(
                (offer) =>
                    offer.maker === makerAddress &&
                    this.isOfferManagedByJob(job, offer),
            );
            if (makerOffers.length === 0) {
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
            await this.cancelMakerOffers(job, makerOffers);
            this.clearTrackedOrder(job);
            return makerOffers.length;
        });
    }

    public async activateJob(
        jobId: string,
        options: BidderActivationOptions,
    ): Promise<void> {
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

        await this.refreshJobImmediately(jobId);
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
                    job.target.type === "token" &&
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
            "currentPriceBootstrapStarted",
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

                const warmed = await this.tryWarmCurrentPrice(job, {
                    sequence: candidateIndex + 1,
                    total: warmCandidates.length,
                });
                completedCount++;
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
            "currentPriceBootstrapComplete",
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
            if (job.target.type !== "token") {
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

        await Promise.all(
            matchingJobIds.map((jobId) => this.refreshJob(jobId)),
        );
    }

    public start(): void {
        if (this.started) {
            return;
        }

        this.started = true;
        void this.runTickLoop();
    }

    // stop cancels the recurring bidder timer so the runtime can shut down cleanly.
    public stop(): void {
        this.started = false;
        if (this.pollTimer) {
            clearTimeout(this.pollTimer);
            this.pollTimer = undefined;
        }
    }

    public async tick(): Promise<void> {
        const refreshed = await this.refreshCachedMakerWethBalance();
        log.debug("tickStarted", "Bidder tick started", {
            makerAddress: this.makerAddress,
            makerWethBalanceWei:
                this.cachedMakerWethBalance?.toString() ?? null,
            makerWethBalance: this.formatTickBalanceForLog(),
            makerWethBalanceRefreshed: refreshed,
            makerWethBalanceCached:
                !refreshed && this.cachedMakerWethBalance !== undefined,
        });
        const jobs = Array.from(this.jobs.values());
        await Promise.all(
            jobs.map((job, index) =>
                this.refreshJob(job.id, {
                    sequence: index + 1,
                    total: jobs.length,
                }),
            ),
        );
    }

    public async refreshJob(
        jobId: string,
        context?: ProgressContext,
    ): Promise<void> {
        const state = this.getJobExecutionState(jobId);

        if (state.running) {
            state.pending = true;
            if (context) {
                state.pendingContext = context;
            }
            return state.inFlightPromise ?? Promise.resolve();
        }

        state.running = true;
        state.pending = false;
        state.pendingContext = undefined;
        state.inFlightPromise = this.runJobRefreshLoop(
            jobId,
            state,
            context,
        ).finally(() => {
            state.running = false;
            state.pending = false;
            state.pendingContext = undefined;
            state.inFlightPromise = undefined;
        });

        return state.inFlightPromise;
    }

    private isDryRun(): boolean {
        return this.options.dryRun === true;
    }

    private async runJobRefreshLoop(
        jobId: string,
        state: JobExecutionState,
        context?: ProgressContext,
    ): Promise<void> {
        let nextContext = context;

        while (true) {
            await this.jobExecutionSemaphore.runExclusive(async () => {
                const jobMutex = this.getJobMutex(jobId);
                await jobMutex.runExclusive(async () => {
                    state.executing = true;
                    try {
                        await this.executeJob(jobId, nextContext);
                    } finally {
                        state.executing = false;
                    }
                });
            });

            if (!state.pending) {
                return;
            }

            nextContext = state.pendingContext;
            state.pending = false;
            state.pendingContext = undefined;
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

    private async refreshJobImmediately(jobId: string): Promise<void> {
        log.debug(
            "immediateRefreshStarted",
            "Executing immediate bidding job refresh",
            {
                jobId,
            },
        );
        const jobMutex = this.getJobMutex(jobId);
        await jobMutex.runExclusive(async () => {
            await this.executeJob(jobId);
        });
    }

    private async runTickLoop(): Promise<void> {
        if (!this.started) {
            return;
        }

        try {
            await this.tick();
        } catch (error: unknown) {
            log.error("tickFailed", "Bidder tick failed", {
                ...toErrorLogFields(error),
            });
        }

        if (!this.started) {
            return;
        }

        this.pollTimer = setTimeout(() => {
            void this.runTickLoop();
        }, this.pollIntervalMs);
    }

    private async executeJob(
        jobId: string,
        context?: ProgressContext,
    ): Promise<void> {
        try {
            const job = this.jobs.get(jobId);
            if (!job) {
                return;
            }

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

            const offers = await this.biddingService.getActiveOffers(job);

            if (job.state.activeOrderId) {
                const activeId = job.state.activeOrderId;
                const foundInMarket = offers.find(
                    (offer) => offer.id === activeId,
                );

                if (!foundInMarket) {
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
                        job.target.type === "token"
                            ? job.target.tokenId
                            : undefined;
                    const recovered = await this.biddingService.getOrder(
                        activeId,
                        job.state.activeProtocolAddress,
                        job.collectionAddress,
                        tokenId,
                        job.collectionSlug,
                    );

                    if (recovered) {
                        log.info(
                            "activeBidRecovered",
                            "Recovered active bid from tracked state",
                            {
                                jobId: job.id,
                                jobRef,
                                orderId: activeId,
                                protocolAddress:
                                    recovered.protocolAddress ?? null,
                            },
                        );
                        offers.push(recovered);
                        if (
                            !job.state.activeProtocolAddress &&
                            recovered.protocolAddress
                        ) {
                            job.state.activeProtocolAddress =
                                recovered.protocolAddress;
                        }
                    } else {
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
                } else if (
                    !job.state.activeProtocolAddress &&
                    foundInMarket.protocolAddress
                ) {
                    job.state.activeProtocolAddress =
                        foundInMarket.protocolAddress;
                }
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
            const visibleMyOffers = sortedOffers.filter(
                (offer) => offer.maker === myAddress,
            );
            const myOffers = visibleMyOffers.filter((offer) =>
                this.isOfferManagedByJob(job, offer),
            );
            const competitorOffers = sortedOffers.filter(
                (offer) => offer.maker !== myAddress,
            );
            const myHighest = myOffers[0];
            const competitorHighest = competitorOffers[0];

            const runtimeOverride = this.getRuntimeOverride(job.id);
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
                    await this.cancelMakerOffers(job, myOffers);
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
                await this.placeAndTrack(job, desiredPrice, {
                    competitorPrice,
                    floor,
                    ceiling,
                });
                return;
            }

            const myPrice = myHighest.price;
            const matchingMakerOffer = myOffers.find(
                (offer) => offer.price === desiredPrice,
            );

            if (renewalReason) {
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
                await this.placeAndTrack(job, desiredPrice, {
                    competitorPrice,
                    floor,
                    ceiling,
                });
                await this.cancelMakerOffers(job, myOffers);
                return;
            }

            if (matchingMakerOffer) {
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
            await this.placeAndTrack(job, desiredPrice, {
                competitorPrice,
                floor,
                ceiling,
            });
            await this.cancelMakerOffers(job, myOffers);
        } catch (error: unknown) {
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

                void this.refreshJobImmediately(jobId).catch(
                    (error: unknown) => {
                        log.error(
                            "runtimeOverrideExpiryRefreshFailed",
                            "Failed to refresh bidding job after runtime override expiry",
                            {
                                jobId,
                                activationId: override.activationId,
                                ...toErrorLogFields(error),
                            },
                        );
                    },
                );
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
            jobTokenId: job.target.type === "token" ? job.target.tokenId : "",
            currentPrice: job.state.currentPrice,
            traitCriteria: marketEvent.getTraitCriteria(),
        };

        if (job.target.type !== "token") {
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

    private async tryWarmCurrentPrice(
        job: BidderJob,
        context?: ProgressContext,
    ): Promise<boolean> {
        if (job.target.type !== "token") {
            return false;
        }

        try {
            const activeOffer =
                await this.biddingService.getActiveTokenOfferByMaker(
                    job,
                    this.makerAddress,
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

        log.debug(
            "hotRefreshNoEffect",
            "Hot refresh had no matching bidding job",
            {
                eventScope: marketEvent.getScope(),
                eventTarget: this.formatEventTargetForLog(
                    marketEvent.getCollectionSlug(),
                    marketEvent.getScope(),
                    marketEvent.getItemID(),
                    marketEvent.getTraitCriteria(),
                ),
                eventType: marketEvent.getType(),
                eventPriceWei: marketEvent.getUnitPrice().toString(),
                eventPrice: formatUnits(
                    marketEvent.getUnitPrice(),
                    marketEvent.getPaymentTokenDecimals(),
                ),
                candidateCount: evaluations.length,
                reasons:
                    reasonSummary ||
                    this.describeNoCandidateReason(marketEvent),
            },
        );
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
            this.cachedMakerWethBalance =
                await this.makerWethBalanceService.getWethBalance(
                    this.makerAddress,
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

    private formatTickBalanceForLog(): string {
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
        if (job.target.type !== "token") {
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
        if (job.target.type !== "token") {
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
        const rawCriteria =
            (
                order.rawOrder as
                    | {
                          criteria?: unknown;
                          protocolData?: { criteria?: unknown };
                          protocol_data?: { criteria?: unknown };
                      }
                    | undefined
            )?.criteria ??
            (
                order.rawOrder as
                    | {
                          protocolData?: { criteria?: unknown };
                      }
                    | undefined
            )?.protocolData?.criteria ??
            (
                order.rawOrder as
                    | {
                          protocol_data?: { criteria?: unknown };
                      }
                    | undefined
            )?.protocol_data?.criteria;

        return this.normalizeTraitTargets(rawCriteria);
    }

    private normalizeTraitTargets(criteria: unknown): TraitCriterion[] {
        if (!criteria) {
            return [];
        }

        if (Array.isArray(criteria)) {
            return criteria.flatMap((entry) =>
                this.normalizeTraitTargets(entry),
            );
        }

        const candidate = criteria as {
            trait?: unknown;
            traits?: unknown;
            type?: string;
            trait_type?: string;
            value?: unknown;
            trait_value?: unknown;
        };
        const trait = candidate.trait;
        const traits = candidate.traits;
        if (trait || traits) {
            return this.normalizeTraitTargets(trait || traits);
        }

        const type = candidate.type ?? candidate.trait_type;
        const value = candidate.value ?? candidate.trait_value;
        if (typeof type === "string" && value !== undefined && value !== null) {
            return [{ type, value: String(value) }];
        }

        if (typeof criteria === "object") {
            const normalized: TraitCriterion[] = [];
            for (const [key, rawValue] of Object.entries(
                criteria as Record<string, unknown>,
            )) {
                if (
                    rawValue === undefined ||
                    rawValue === null ||
                    typeof rawValue === "object"
                ) {
                    continue;
                }

                normalized.push({ type: key, value: String(rawValue) });
            }
            return normalized;
        }

        return [];
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
        if (job.target.type === "token") {
            return order.offerScope === "item";
        }

        if (job.target.type === "collection") {
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

        if (job.target.type === "competitiveTrait") {
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
    ): Promise<void> {
        job.state.lastRun = Date.now();
        const jobRef = formatBidderJobReference(job);

        if (this.isDryRun()) {
            if (
                job.target.type === "collection" ||
                job.target.type === "competitiveTrait"
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

        const { orderHash, protocolAddress, expirationTime } =
            await this.biddingService.placeOffer(job, amount);
        job.state.activeOrderId = orderHash;
        job.state.activeProtocolAddress = protocolAddress;
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
        this.persistJobRuntimeState(job);
        if (
            job.target.type === "collection" ||
            job.target.type === "competitiveTrait"
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

    private async cancelAndTrack(job: BidderJob, order: Order): Promise<void> {
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
        await this.biddingService.cancelOffer(job, order);
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

        job.state.activeOrderId = order.id;
        job.state.activeProtocolAddress = order.protocolAddress;
        job.state.currentPrice = order.price;
        job.state.activeExpirationTimeMs = nextExpirationTimeMs;
        this.persistJobRuntimeState(job);
    }

    private clearTrackedOrder(job: BidderJob): void {
        job.state.activeOrderId = undefined;
        job.state.activeProtocolAddress = undefined;
        job.state.currentPrice = undefined;
        job.state.activeExpirationTimeMs = undefined;
        this.clearRuntimeBidDecision(job);
        this.persistJobRuntimeState(job);
    }

    private persistJobRuntimeState(
        job: BidderJob,
        lastError: string | null = null,
    ): void {
        if (!this.runtimeStatePort) {
            return;
        }

        const snapshot: BiddingJobRuntimeStateSnapshot = {
            jobId: job.id,
            currentPriceWei: job.state.currentPrice?.toString() ?? null,
            activeOrderId: job.state.activeOrderId ?? null,
            activeProtocolAddress: job.state.activeProtocolAddress ?? null,
            activeExpirationTimeMs: job.state.activeExpirationTimeMs ?? null,
            bidPosition: job.state.bidPosition ?? null,
            bidConstraints: job.state.bidConstraints ?? [],
            competitorPriceWei: job.state.competitorPrice?.toString() ?? null,
            lastRunAt: job.state.lastRun
                ? new Date(job.state.lastRun).toISOString()
                : null,
            lastError,
        };

        // Persist runtime feedback for backend read models without changing bidder decisions if SQLite is slow or unavailable.
        void Promise.resolve(
            this.runtimeStatePort.persistJobRuntimeState(snapshot),
        ).catch((error: unknown) => {
            log.error(
                "runtimeStatePersistFailed",
                "Failed to persist bidding job runtime state",
                {
                    jobId: job.id,
                    jobRef: formatBidderJobReference(job),
                    ...toErrorLogFields(error),
                },
            );
        });
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
    ): Promise<void> {
        for (const offer of myOffers) {
            if (keepOrderId && offer.id === keepOrderId) {
                continue;
            }

            await this.cancelAndTrack(job, offer);
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
            existingJob.target.type === "token" &&
            nextJob.target.type === "token"
        ) {
            return existingJob.target.tokenId === nextJob.target.tokenId;
        }

        if (
            existingJob.target.type === "collection" &&
            nextJob.target.type === "collection"
        ) {
            return this.matchesExactTraitTargets(
                existingJob.target.traits ?? [],
                nextJob.target.traits ?? [],
            );
        }

        if (
            existingJob.target.type === "competitiveTrait" &&
            nextJob.target.type === "competitiveTrait"
        ) {
            return this.matchesExactTraitTargets(
                [existingJob.target.targetTrait],
                [nextJob.target.targetTrait],
            );
        }

        return false;
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
        const renewalWindowMs = this.pollIntervalMs * 2;
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
