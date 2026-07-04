import { formatUnits } from "viem";
import {
    getOpenSeaOfferCriteria,
    inferOpenSeaNftSelectionKind,
    isOpenSeaCollectionWideOffer,
    normalizeOpenSeaOfferTraitCriteria,
    parseOpenSeaBiddingOffer,
} from "@artgod/shared/trading/open-sea-bidding-offers";
import {
    BIDDING_ORDER_RECOVERY_REASON,
    BIDDING_ORDER_RECOVERY_STATUS,
    BIDDING_SERVICE_REQUEST_PRIORITY,
    BiddingOrderRecoveryResult,
    BiddingService,
    BiddingServiceRequestContext,
    OfferDiscoverySource,
    Order,
} from "../../application/use-cases/bidding/bidding-service.js";
import {
    CollectionOfferSnapshot,
    CollectionOfferSnapshotProvider,
} from "../../application/use-cases/bidding/collection-offer-snapshot-service.js";
import { TokenMetadataRepository } from "../../domain/market/token-metadata-repository.js";
import {
    BidderJob,
    formatBidderJobReference,
    TraitSelector,
    TraitTarget,
} from "../../domain/market/strategy/job.js";
import {
    BIDDING_DEFAULT_COMPETITIVE_TRAIT_MAX_LOOKUP_SELECTORS,
    BIDDING_DEFAULT_OFFER_EXPIRATION_SECONDS,
    BIDDING_DEFAULT_OPEN_SEA_OFFERS_PAGE_SIZE,
    BIDDING_DEFAULT_ORDER_LOOKUP_MAX_PAGES,
    BIDDING_DEFAULT_TOKEN_CRITERIA_TRAITS_BY_COLLECTION,
} from "../../config/bidding-defaults.js";
import {
    BIDDING_LOG_COMPONENT,
    createBiddingComponentLogger,
    toErrorLogFields,
} from "../../utils/bidding-log.js";
import { defaultRetryPolicy, RetryPolicy, retry } from "../support/retry.js";
import {
    TOKEN_BUCKET_RATE_LIMIT_PRIORITY,
    TokenBucketRateLimiter,
    type TokenBucketRateLimitPriority,
} from "../support/token-bucket-rate-limiter.js";
import {
    OpenSeaApiClient,
    OpenSeaBiddingSdkClient,
} from "./open-sea-client.js";

type SnapshotScanSummary = {
    collectionWideAdded: number;
    explicitItemSkipped: number;
    criteriaSeen?: number;
    criteriaMatched?: number;
    criteriaMismatched?: number;
    criteriaUntracked?: number;
    encodedTokenIdsMatched?: number;
    encodedTokenIdsSkipped?: number;
    exactCriteriaMatched?: number;
    metadataFound?: boolean;
    tokenTraits?: TraitTarget[];
    mismatchSamples?: string[];
};

export interface OpenSeaBiddingServiceOptions {
    collectionOfferSnapshotProvider?: CollectionOfferSnapshotProvider;
    tokenMetadataRepository?: TokenMetadataRepository;
    rateLimiter?: TokenBucketRateLimiter;
    retryPolicy?: RetryPolicy;
    offerExpirationSeconds?: number;
    orderLookupMaxPages?: number;
    offersPageSize?: number;
    tokenCriteriaTraitsByCollection?: Record<string, string[]>;
    competitiveTraitMaxLookupSelectors?: number;
}

const OPENSEA_WETH_ADDRESS = "0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2";
const OPENSEA_MAINNET_CHAIN = "ethereum";
const log = createBiddingComponentLogger(
    BIDDING_LOG_COMPONENT.OpenSeaBiddingService,
);

const PERMANENT_OPENSEA_ERROR_PATTERNS = [
    /\bNFT with identifier .+ not found in collection\b/i,
    /\bunsupported trait\b/i,
    /\btrait .+ not found\b/i,
];

const sdkCallCosts: Record<string, { get: number; post: number }> = {
    getOffersByNFT: { get: 1, post: 0 },
    getCollectionOffers: { get: 1, post: 0 },
    getTraitOffers: { get: 1, post: 0 },
    getTraits: { get: 1, post: 0 },
    getBestOffer: { get: 1, post: 0 },
    getOrderByHash: { get: 1, post: 0 },
    getAllOffers: { get: 1, post: 0 },
    createCollectionOffer: { get: 1, post: 2 },
    createOffer: { get: 1, post: 2 },
    offchainCancelOrder: { get: 0, post: 1 },
};

// OpenSeaBiddingService preserves the upstream offer-discovery and order-management logic behind ArtGod's BiddingService port.
export class OpenSeaBiddingService implements BiddingService {
    private readonly collectionOfferSnapshotProvider?: CollectionOfferSnapshotProvider;
    private readonly tokenMetadataRepository?: TokenMetadataRepository;
    private readonly rateLimiter: TokenBucketRateLimiter;
    private readonly retryPolicy: RetryPolicy;
    private readonly offerExpirationSeconds: number;
    private readonly orderLookupMaxPages: number;
    private readonly offersPageSize: number;
    private readonly tokenCriteriaTraitsByCollection: Record<string, string[]>;
    private readonly competitiveTraitMaxLookupSelectors: number;

    constructor(
        private readonly sdk: OpenSeaBiddingSdkClient,
        private readonly makerAddress: string,
        options: OpenSeaBiddingServiceOptions = {},
    ) {
        this.collectionOfferSnapshotProvider =
            options.collectionOfferSnapshotProvider;
        this.tokenMetadataRepository = options.tokenMetadataRepository;
        this.rateLimiter =
            options.rateLimiter ??
            new TokenBucketRateLimiter({
                getMax: 4,
                getRefillPerSecond: 4,
                postMax: 2,
                postRefillPerSecond: 2,
            });
        this.retryPolicy = options.retryPolicy ?? defaultRetryPolicy;
        this.offerExpirationSeconds =
            options.offerExpirationSeconds ??
            BIDDING_DEFAULT_OFFER_EXPIRATION_SECONDS;
        this.orderLookupMaxPages = Math.max(
            1,
            options.orderLookupMaxPages ??
                BIDDING_DEFAULT_ORDER_LOOKUP_MAX_PAGES,
        );
        this.offersPageSize = Math.max(
            1,
            options.offersPageSize ?? BIDDING_DEFAULT_OPEN_SEA_OFFERS_PAGE_SIZE,
        );
        this.tokenCriteriaTraitsByCollection =
            options.tokenCriteriaTraitsByCollection ??
            BIDDING_DEFAULT_TOKEN_CRITERIA_TRAITS_BY_COLLECTION;
        this.competitiveTraitMaxLookupSelectors = Math.max(
            1,
            options.competitiveTraitMaxLookupSelectors ??
                BIDDING_DEFAULT_COMPETITIVE_TRAIT_MAX_LOOKUP_SELECTORS,
        );
    }

    public async getActiveOffers(
        job: BidderJob,
        context: BiddingServiceRequestContext = {},
    ): Promise<Order[]> {
        const offers: Order[] = [];
        const lookupTraitSelectors = this.getLookupTraitSelectors(job);
        const isCompetitiveTraitJob = job.target.type === "competitiveTrait";
        const competitiveBucketCounts = {
            collectionWide: new Set<string>(),
            targetTrait: new Set<string>(),
            competitorTraits: new Set<string>(),
        };
        let expandedTraitSelectorCount = 0;

        if (job.target.type === "token") {
            const tokenTarget = job.target;
            try {
                // 1. Fetch live item-specific offers for the exact token because this path must stay latency-sensitive.
                const itemOffers = await this.fetchNftOffers(
                    job.collectionSlug,
                    tokenTarget.tokenId,
                    "item offers",
                    context,
                );

                for (const rawOrder of itemOffers) {
                    const parsed = this.parseRawOffer(
                        rawOrder,
                        job.collectionAddress,
                        "itemOffers",
                    );
                    if (!parsed) {
                        continue;
                    }

                    this.addUniqueOffer(offers, parsed);
                }
            } catch (error) {
                log.error(
                    "itemOffersFetchFailed",
                    "Failed to get item offers",
                    {
                        ...jobLogFields(job),
                        ...toErrorLogFields(error),
                    },
                );
                throw error;
            }
        }

        if (job.target.type === "token") {
            try {
                // 2. Fetch broader collection-wide and criteria offers from the shared snapshot for token jobs.
                const cachedSnapshotOffers =
                    await this.getCachedTokenSnapshotOffers(job);
                cachedSnapshotOffers.forEach((offer) =>
                    this.addUniqueOffer(offers, offer),
                );
            } catch (error) {
                log.error(
                    "cachedTokenSnapshotOffersReadFailed",
                    "Failed to read cached token snapshot offers",
                    {
                        ...jobLogFields(job),
                        ...toErrorLogFields(error),
                    },
                );
                throw error;
            }
        } else {
            try {
                if (job.target.type === "collection") {
                    // 2a. Reuse the cached snapshot first for collection jobs so broad offer discovery stays authoritative but cheap.
                    const cachedSnapshotOffers =
                        this.getCachedCollectionSnapshotOffers(job);
                    if (cachedSnapshotOffers) {
                        cachedSnapshotOffers.forEach((offer) =>
                            this.addUniqueOffer(offers, offer),
                        );
                    } else {
                        // 2b. Fall back to live collection-offer pagination only when the snapshot is unavailable.
                        const collectionOffers =
                            await this.fetchAllCollectionOffers(
                                job.collectionSlug,
                                context,
                            );
                        this.getLiveCollectionTargetOffers(
                            job,
                            collectionOffers,
                        ).forEach((offer) =>
                            this.addUniqueOffer(offers, offer),
                        );
                    }
                }

                if (job.target.type === "competitiveTrait") {
                    const competitiveTarget = job.target;
                    // Expand type-only selectors into explicit trait targets before fetching each competing trait bucket.
                    const expandedTraitTargets =
                        await this.expandCompetitiveTraitSelectors(
                            job,
                            lookupTraitSelectors,
                            context,
                        );
                    expandedTraitSelectorCount = expandedTraitTargets.length;
                    if (
                        expandedTraitTargets.length >
                        this.competitiveTraitMaxLookupSelectors
                    ) {
                        throw new Error(
                            `[OpenSeaBiddingService] Competitive trait lookup selector count exceeds configured limit: jobId=${job.id}, selectorCount=${expandedTraitTargets.length}, limit=${this.competitiveTraitMaxLookupSelectors}`,
                        );
                    }
                    log.debug(
                        "competitiveTraitLookupResolved",
                        "Competitive trait lookup resolved selectors",
                        {
                            ...jobLogFields(job),
                            selectorCount: expandedTraitTargets.length,
                        },
                    );

                    // Competitive-trait jobs stay live, but fail the fan-out guard before expensive collection pagination.
                    const collectionOffers =
                        await this.fetchAllCollectionOffers(
                            job.collectionSlug,
                            context,
                        );

                    // Always include collection-wide offers from the live collection page.
                    collectionOffers.forEach((rawOffer) => {
                        if (!this.isCollectionWideOffer(rawOffer)) {
                            return;
                        }

                        const parsed = this.parseRawOffer(
                            rawOffer,
                            job.collectionAddress,
                            "collectionOffers",
                        );
                        if (!parsed) {
                            return;
                        }

                        competitiveBucketCounts.collectionWide.add(parsed.id);
                        this.addUniqueOffer(offers, parsed);
                    });

                    for (const traitTarget of expandedTraitTargets) {
                        // Fetch the live offers for each explicit target or competitor trait bucket.
                        const traitOffers = await this.fetchAllTraitOffers(
                            job.collectionSlug,
                            traitTarget.type,
                            traitTarget.value,
                            context,
                        );

                        traitOffers.forEach((rawOffer) => {
                            const parsed = this.parseRawOffer(
                                rawOffer,
                                job.collectionAddress,
                                "traitOffers",
                            );
                            if (!parsed) {
                                return;
                            }

                            const isTargetTrait =
                                traitTarget.type ===
                                    competitiveTarget.targetTrait.type &&
                                traitTarget.value ===
                                    competitiveTarget.targetTrait.value;
                            if (isTargetTrait) {
                                competitiveBucketCounts.targetTrait.add(
                                    parsed.id,
                                );
                            } else {
                                competitiveBucketCounts.competitorTraits.add(
                                    parsed.id,
                                );
                            }

                            this.addUniqueOffer(offers, parsed);
                        });
                    }
                }
            } catch (error) {
                log.error(
                    "collectionTraitOffersFetchFailed",
                    "Failed to fetch collection or trait offers",
                    {
                        ...jobLogFields(job),
                        ...toErrorLogFields(error),
                    },
                );
                throw error;
            }
        }

        if (job.target.type === "token") {
            const tokenTarget = job.target;
            try {
                // 3. Fetch best-offer as a catch-all fallback because OpenSea visibility is not perfectly uniform across endpoints.
                const bestOffer = await this.withRetry(
                    "getBestOffer",
                    "best offer",
                    () =>
                        this.sdk.api.getBestOffer(
                            job.collectionSlug,
                            tokenTarget.tokenId,
                        ),
                    context,
                );

                const parsed = this.parseRawOffer(
                    bestOffer,
                    job.collectionAddress,
                    "bestOffer",
                );
                if (parsed && !offers.find((offer) => offer.id === parsed.id)) {
                    log.debug("bestOfferFound", "Found best offer", {
                        ...jobLogFields(job),
                        ...orderLogFields(parsed),
                    });
                    offers.push(parsed);
                }
            } catch (error) {
                if (!isNotFoundError(error)) {
                    log.error(
                        "bestOfferFetchFailed",
                        "Failed to get best offer",
                        {
                            ...jobLogFields(job),
                            ...toErrorLogFields(error),
                        },
                    );
                    throw error;
                }
            }
        }

        if (isCompetitiveTraitJob) {
            log.debug(
                "competitiveTraitBuckets",
                "Competitive trait offer buckets resolved",
                {
                    ...jobLogFields(job),
                    collectionWideOfferCount:
                        competitiveBucketCounts.collectionWide.size,
                    targetTraitOfferCount:
                        competitiveBucketCounts.targetTrait.size,
                    competitorTraitOfferCount:
                        competitiveBucketCounts.competitorTraits.size,
                    selectorsRequested: lookupTraitSelectors.length,
                    selectorsExpanded: expandedTraitSelectorCount,
                    trackedOfferCount: offers.length,
                },
            );
        }

        return offers.sort((left, right) =>
            left.price > right.price ? -1 : 1,
        );
    }

    public async getActiveTokenOfferByMaker(
        job: BidderJob,
        makerAddress: string,
        context: BiddingServiceRequestContext = {},
    ): Promise<Order | null> {
        if (job.target.type !== "token") {
            return null;
        }
        const tokenTarget = job.target;

        try {
            const tokenOffers = await this.fetchNftOffers(
                job.collectionSlug,
                tokenTarget.tokenId,
                "maker token offers",
                context,
            );

            for (const rawOrder of tokenOffers) {
                const parsed = this.parseRawOffer(
                    rawOrder,
                    job.collectionAddress,
                    "itemOffers",
                );
                if (
                    parsed?.maker.toLowerCase() === makerAddress.toLowerCase()
                ) {
                    return parsed;
                }
            }

            return null;
        } catch (error) {
            log.error(
                "activeTokenOfferByMakerFetchFailed",
                "Failed to get active token offer by maker",
                {
                    ...jobLogFields(job),
                    makerAddress,
                    ...toErrorLogFields(error),
                },
            );
            throw error;
        }
    }

    public async getOrder(
        orderHash: string,
        protocolAddress?: string,
        collectionAddress?: string,
        _tokenId?: string,
        collectionSlug?: string,
        context: BiddingServiceRequestContext = {},
    ): Promise<BiddingOrderRecoveryResult> {
        let foundOrder: unknown = null;
        let directLookupInconclusive = false;

        if (protocolAddress) {
            try {
                log.debug(
                    "orderDirectLookupStarted",
                    "Fetching order by hash",
                    {
                        orderHash,
                        protocolAddress,
                    },
                );
                const response = await this.withRetry(
                    "getOrderByHash",
                    "order by hash",
                    () =>
                        this.sdk.api.getOrderByHash(orderHash, protocolAddress),
                    context,
                );

                if (matchesOrderHash(response, orderHash)) {
                    foundOrder = response;
                    log.debug(
                        "orderDirectLookupFound",
                        "Found order by direct lookup",
                        {
                            orderHash,
                            protocolAddress,
                        },
                    );
                }
            } catch (error) {
                log.debug(
                    "orderDirectLookupFailed",
                    "Order direct lookup failed",
                    {
                        orderHash,
                        protocolAddress,
                        ...toErrorLogFields(error),
                    },
                );
                directLookupInconclusive = !isDirectOrderAbsentError(error);
            }
        }

        if (!foundOrder) {
            log.debug("orderNotFound", "Order not found in market", {
                orderHash,
                collectionSlug: collectionSlug ?? null,
                directLookupInconclusive,
            });
            if (!directLookupInconclusive) {
                return {
                    status: BIDDING_ORDER_RECOVERY_STATUS.InactiveOrMissing,
                };
            }
            return {
                status: BIDDING_ORDER_RECOVERY_STATUS.Inconclusive,
                reason: protocolAddress
                    ? BIDDING_ORDER_RECOVERY_REASON.DirectLookupFailed
                    : BIDDING_ORDER_RECOVERY_REASON.LookupUnavailable,
            };
        }

        const parsed = this.parseRawOffer(
            foundOrder,
            collectionAddress,
            "stateRecovery",
        );
        if (!parsed) {
            return {
                status: BIDDING_ORDER_RECOVERY_STATUS.Inconclusive,
                reason: BIDDING_ORDER_RECOVERY_REASON.ParseFailed,
            };
        }

        const status = stringOrUndefined(
            asRecord(foundOrder)?.status,
        )?.toLowerCase();
        if (status) {
            if (status !== "active") {
                log.debug(
                    "recoveredOrderInactive",
                    "Recovered order is not active",
                    {
                        orderHash,
                        status,
                    },
                );
                return {
                    status: BIDDING_ORDER_RECOVERY_STATUS.InactiveOrMissing,
                };
            }

            log.debug("orderRecovered", "Successfully recovered order", {
                orderHash,
                status,
            });
            return {
                status: BIDDING_ORDER_RECOVERY_STATUS.Active,
                order: parsed,
            };
        }

        if (isLegacyInactive(foundOrder)) {
            log.debug(
                "recoveredOrderLegacyInactive",
                "Recovered order is not active by legacy checks",
                { orderHash },
            );
            return { status: BIDDING_ORDER_RECOVERY_STATUS.InactiveOrMissing };
        }

        return {
            status: BIDDING_ORDER_RECOVERY_STATUS.Active,
            order: parsed,
        };
    }

    public async placeOffer(
        job: BidderJob,
        amount: bigint,
        context: BiddingServiceRequestContext = {},
    ): Promise<{
        orderHash: string;
        protocolAddress: string;
        placedAt: string;
        expirationTime?: number;
    }> {
        const expirationTime =
            Math.floor(Date.now() / 1000) + this.offerExpirationSeconds;

        try {
            if (
                job.target.type === "collection" ||
                job.target.type === "competitiveTrait"
            ) {
                const quantity = Math.max(1, Math.floor(job.target.quantity));
                const totalAmountDecimal = formatUnits(
                    amount * BigInt(quantity),
                    18,
                );
                const placementTraits = this.getPlacementTraits(job);
                const singlePlacementTrait =
                    placementTraits.length === 1
                        ? placementTraits[0]
                        : undefined;
                const traitType =
                    job.target.type === "competitiveTrait"
                        ? singlePlacementTrait?.type
                        : undefined;
                const traitValue =
                    job.target.type === "competitiveTrait"
                        ? singlePlacementTrait?.value
                        : undefined;
                const traits =
                    job.target.type === "collection" &&
                    placementTraits.length > 0
                        ? placementTraits
                        : undefined;

                const order = await this.trackSdkCall(
                    "createCollectionOffer",
                    () =>
                        this.sdk.createCollectionOffer({
                            collectionSlug: job.collectionSlug,
                            accountAddress: this.makerAddress,
                            amount: totalAmountDecimal,
                            quantity,
                            traitType,
                            traitValue,
                            traits,
                            expirationTime,
                        }),
                    context,
                );
                const placedAt = new Date().toISOString();
                if (!order) {
                    throw new Error(
                        "Failed to create collection offer (no order returned)",
                    );
                }

                const identity = requirePlacedOrderIdentity(order);
                return {
                    ...identity,
                    placedAt,
                    expirationTime:
                        this.tryParseNumber(
                            order.expiration_time ?? order.expirationTime,
                        ) ?? expirationTime,
                };
            }

            if (job.target.type !== "token") {
                throw new Error(
                    "Invalid target type for placeOffer (expected token)",
                );
            }
            const tokenTarget = job.target;

            const order = await this.trackSdkCall(
                "createOffer",
                () =>
                    this.sdk.createOffer({
                        asset: {
                            tokenAddress: job.collectionAddress,
                            tokenId: tokenTarget.tokenId,
                        },
                        accountAddress: this.makerAddress,
                        amount: formatUnits(amount, 18),
                        expirationTime,
                    }),
                context,
            );
            const placedAt = new Date().toISOString();
            if (!order) {
                throw new Error(
                    "Failed to create token offer (no order returned)",
                );
            }

            const identity = requirePlacedOrderIdentity(order);
            return {
                ...identity,
                placedAt,
                expirationTime:
                    this.tryParseNumber(
                        order.expiration_time ?? order.expirationTime,
                    ) ?? expirationTime,
            };
        } catch (error) {
            log.error("offerPlaceFailed", "Failed to place offer", {
                ...jobLogFields(job),
                amountWei: amount.toString(),
                amountEth: formatUnits(amount, 18),
                ...toErrorLogFields(error),
            });
            throw error;
        }
    }

    public async cancelOffer(
        _job: BidderJob,
        order: Order,
        context: BiddingServiceRequestContext = {},
    ): Promise<void> {
        await this.cancelOrder(order, context);
    }

    public async cancelRecoveredOrder(
        order: Order,
        context: BiddingServiceRequestContext = {},
    ): Promise<void> {
        await this.cancelOrder(order, context);
    }

    private async cancelOrder(
        order: Order,
        context: BiddingServiceRequestContext,
    ): Promise<void> {
        try {
            if (!order.protocolAddress) {
                throw new Error(
                    "Missing protocolAddress for offchain cancellation",
                );
            }

            await retry(
                async () => {
                    await this.trackSdkCall(
                        "offchainCancelOrder",
                        () =>
                            this.sdk.offchainCancelOrder(
                                order.protocolAddress!,
                                order.id,
                                OPENSEA_MAINNET_CHAIN,
                                undefined,
                                true,
                            ),
                        context,
                    );
                },
                this.retryPolicy,
                {
                    shouldRetry: isRetryableOpenSeaBiddingError,
                    onRetry: ({ attempt, error }) => {
                        log.info(
                            "offerCancelRetry",
                            "Retrying offer cancellation",
                            {
                                orderId: order.id,
                                protocolAddress: order.protocolAddress ?? null,
                                attempt,
                                ...toErrorLogFields(error),
                            },
                        );
                    },
                },
            );
        } catch (error) {
            log.error(
                "offerCancelFailed",
                "Failed to cancel offer after retries",
                {
                    ...orderLogFields(order),
                    ...toErrorLogFields(error),
                },
            );
            throw error;
        }
    }

    private async trackSdkCall<T>(
        action: string,
        fn: () => Promise<T>,
        context: BiddingServiceRequestContext = {},
    ): Promise<T> {
        const cost = sdkCallCosts[action] ?? { get: 1, post: 0 };
        await this.rateLimiter.wait(cost.get, cost.post, {
            priority: toRateLimitPriority(context),
        });
        return await fn();
    }

    private async withRetry<T>(
        action: string,
        logLabel: string,
        fn: () => Promise<T>,
        context: BiddingServiceRequestContext = {},
    ): Promise<T> {
        return await retry(
            async () => await this.trackSdkCall(action, fn, context),
            this.retryPolicy,
            {
                shouldRetry: isRetryableOpenSeaBiddingError,
                onRetry: ({ attempt, error }) => {
                    log.info("sdkCallRetry", "Retrying OpenSea SDK call", {
                        sdkAction: action,
                        logLabel,
                        attempt,
                        ...toErrorLogFields(error),
                    });
                },
            },
        );
    }

    private async fetchNftOffers(
        collectionSlug: string,
        tokenId: string,
        logLabel: string,
        context: BiddingServiceRequestContext = {},
    ): Promise<unknown[]> {
        const offers: unknown[] = [];
        let cursor: string | undefined;
        let page = 0;
        const seenCursors = new Set<string>();

        while (page < this.orderLookupMaxPages) {
            const response = await this.withRetry(
                "getOffersByNFT",
                `${logLabel} (page ${page + 1})`,
                () =>
                    this.sdk.api.getOffersByNFT(
                        collectionSlug,
                        tokenId,
                        this.offersPageSize,
                        cursor,
                    ),
                context,
            );

            offers.push(...asArray(response?.offers));

            const next =
                typeof response?.next === "string" ? response.next : undefined;
            if (!next) {
                break;
            }

            if (seenCursors.has(next)) {
                log.error(
                    "nftOfferPaginationLoop",
                    "NFT offer pagination loop detected",
                    {
                        collectionSlug,
                        tokenId,
                        cursor: next,
                    },
                );
                break;
            }

            seenCursors.add(next);
            cursor = next;
            page += 1;
        }

        return offers;
    }

    private tryParseNumber(value: unknown): number | null {
        if (value === null || value === undefined) {
            return null;
        }

        const parsed = Number(value);
        return Number.isFinite(parsed) ? parsed : null;
    }

    private inferNftSelectionKind(
        rawOrder: unknown,
        collectionAddress?: string,
    ): "item" | "criteria" | "unknown" {
        return inferOpenSeaNftSelectionKind(rawOrder, collectionAddress);
    }

    private getOfferCriteria(
        rawOffer: unknown,
    ): Record<string, unknown> | undefined {
        return getOpenSeaOfferCriteria(rawOffer);
    }

    private normalizeOfferTraitCriteria(criteria: unknown): TraitTarget[] {
        return normalizeOpenSeaOfferTraitCriteria(criteria);
    }

    private matchesTraitSelector(
        criteriaTrait: TraitSelector,
        selector: TraitSelector,
    ): boolean {
        if (criteriaTrait.type !== selector.type) {
            return false;
        }

        if (selector.value === undefined) {
            return true;
        }

        return criteriaTrait.value === selector.value;
    }

    private getPlacementTraits(job: BidderJob): TraitTarget[] {
        if (job.target.type === "collection") {
            return this.dedupeTraitTargets(job.target.traits ?? []);
        }
        if (job.target.type === "competitiveTrait") {
            return [job.target.targetTrait];
        }

        return [];
    }

    private getLookupTraitSelectors(job: BidderJob): TraitSelector[] {
        const selectors: TraitSelector[] = [];
        const placementTraits = this.getPlacementTraits(job);

        selectors.push(...placementTraits);
        if (job.target.type === "competitiveTrait") {
            selectors.push(...job.target.competitorTraits);
        }

        const seen = new Set<string>();
        return selectors.filter((selector) => {
            const key = `${selector.type}|${selector.value ?? "*"}`;
            if (seen.has(key)) {
                return false;
            }

            seen.add(key);
            return true;
        });
    }

    private getTrackedCriteriaTraitTypes(
        collectionSlug: string,
    ): Set<string> | null {
        const traitTypes = this.tokenCriteriaTraitsByCollection[collectionSlug];
        if (!traitTypes) {
            return null;
        }

        return new Set(traitTypes);
    }

    private formatTraitTargetsForLog(traits: TraitTarget[]): string {
        if (traits.length === 0) {
            return "none";
        }

        return traits.map((trait) => `${trait.type}=${trait.value}`).join("|");
    }

    private encodedTokenIdsContain(
        encodedTokenIds: string,
        tokenId: string,
    ): boolean {
        if (encodedTokenIds === "*") {
            return true;
        }
        if (encodedTokenIds === "") {
            return false;
        }

        let target: bigint;
        try {
            target = BigInt(tokenId);
        } catch {
            return false;
        }

        for (const segment of encodedTokenIds.split(",")) {
            if (segment.length === 0) {
                continue;
            }

            if (segment.includes(":")) {
                const [startRaw, endRaw] = segment.split(":");
                try {
                    const start = BigInt(startRaw);
                    const end = BigInt(endRaw);
                    if (target >= start && target <= end) {
                        return true;
                    }
                } catch {
                    log.debug(
                        "encodedTokenIdsRangeParseFailed",
                        "Failed to parse encoded token id range",
                        {
                            segment,
                            tokenId,
                        },
                    );
                    return false;
                }
                continue;
            }

            try {
                if (BigInt(segment) === target) {
                    return true;
                }
            } catch {
                log.debug(
                    "encodedTokenIdsValueParseFailed",
                    "Failed to parse encoded token id value",
                    {
                        segment,
                        tokenId,
                    },
                );
                return false;
            }
        }

        return false;
    }

    private addUniqueOffer(
        offers: Order[],
        offer: Order,
        bucket?: Set<string>,
    ): void {
        bucket?.add(offer.id);

        if (!offers.find((existing) => existing.id === offer.id)) {
            offers.push(offer);
        }
    }

    private async getCachedTokenSnapshotOffers(
        job: BidderJob,
    ): Promise<Order[]> {
        if (job.target.type !== "token") {
            return [];
        }
        const tokenTarget = job.target;

        if (!this.collectionOfferSnapshotProvider) {
            log.debug(
                "cachedSnapshotScanSkipped",
                "Cached snapshot scan skipped because no snapshot provider is configured",
                jobLogFields(job),
            );
            return [];
        }

        const snapshot = this.collectionOfferSnapshotProvider.getSnapshot(
            job.collectionSlug,
        );
        if (!snapshot) {
            log.debug(
                "cachedSnapshotMissing",
                "Cached snapshot scan skipped because no snapshot exists",
                jobLogFields(job),
            );
            return [];
        }

        const cachedOffers: Order[] = [];
        const summary: SnapshotScanSummary = {
            collectionWideAdded: 0,
            explicitItemSkipped: 0,
            criteriaSeen: 0,
            criteriaMatched: 0,
            criteriaMismatched: 0,
            criteriaUntracked: 0,
            encodedTokenIdsMatched: 0,
            encodedTokenIdsSkipped: 0,
            mismatchSamples: [],
        };

        snapshot.offers.forEach((rawOffer) => {
            if (
                this.inferNftSelectionKind(rawOffer, job.collectionAddress) ===
                "item"
            ) {
                summary.explicitItemSkipped++;
                return;
            }
            if (!this.isCollectionWideOffer(rawOffer)) {
                return;
            }

            const parsed = this.parseRawOffer(
                rawOffer,
                job.collectionAddress,
                "collectionOffers",
            );
            if (parsed) {
                this.addUniqueOffer(cachedOffers, parsed);
                summary.collectionWideAdded++;
            }
        });

        const trackedTraitTypes = this.getTrackedCriteriaTraitTypes(
            job.collectionSlug,
        );
        const canUseMetadataMatching = Boolean(
            trackedTraitTypes && this.tokenMetadataRepository,
        );
        if (!canUseMetadataMatching) {
            this.logCachedSnapshotSummary(job, snapshot, {
                ...summary,
                metadataFound: false,
                tokenTraits: [],
            });
        }

        let tokenTraits: TraitTarget[] = [];
        let metadataFound = false;
        if (canUseMetadataMatching) {
            tokenTraits = await this.tokenMetadataRepository!.getTraits(
                job.collectionSlug,
                tokenTarget.tokenId,
            );
            metadataFound = tokenTraits.length > 0;
        }

        for (const rawOffer of snapshot.offers) {
            if (this.isCollectionWideOffer(rawOffer)) {
                continue;
            }
            if (
                this.inferNftSelectionKind(rawOffer, job.collectionAddress) ===
                "item"
            ) {
                continue;
            }

            const criteria = this.getOfferCriteria(rawOffer);
            const criteriaTraits = this.normalizeOfferTraitCriteria(criteria);
            if (criteriaTraits.length > 0) {
                summary.criteriaSeen!++;
            }

            const encodedIds =
                stringOrUndefined(criteria?.encoded_token_ids) ??
                stringOrUndefined(criteria?.encodedTokenIds);
            if (
                typeof encodedIds === "string" &&
                encodedIds.length > 0 &&
                encodedIds !== "*"
            ) {
                if (
                    this.encodedTokenIdsContain(encodedIds, tokenTarget.tokenId)
                ) {
                    const parsed = this.parseRawOffer(
                        rawOffer,
                        job.collectionAddress,
                        "traitOffers",
                    );
                    if (parsed) {
                        this.addUniqueOffer(cachedOffers, parsed);
                        summary.encodedTokenIdsMatched!++;
                        summary.criteriaMatched!++;
                    }
                    continue;
                }

                summary.encodedTokenIdsSkipped!++;
                continue;
            }

            if (criteriaTraits.length === 0) {
                continue;
            }

            if (!canUseMetadataMatching) {
                summary.criteriaUntracked!++;
                continue;
            }

            if (
                criteriaTraits.some(
                    (criterion) => !trackedTraitTypes!.has(criterion.type),
                )
            ) {
                summary.criteriaUntracked!++;
                continue;
            }

            if (!metadataFound || tokenTraits.length === 0) {
                summary.criteriaMismatched!++;
                continue;
            }

            const matchesToken = criteriaTraits.every((criterion) =>
                tokenTraits.some(
                    (tokenTrait) =>
                        tokenTrait.type === criterion.type &&
                        tokenTrait.value === criterion.value,
                ),
            );
            if (!matchesToken) {
                summary.criteriaMismatched!++;
                if (summary.mismatchSamples!.length < 5) {
                    summary.mismatchSamples!.push(
                        `${getOrderHash(rawOffer) ?? "unknown"}[${this.formatTraitTargetsForLog(criteriaTraits)}]`,
                    );
                }
                continue;
            }

            const parsed = this.parseRawOffer(
                rawOffer,
                job.collectionAddress,
                "traitOffers",
            );
            if (parsed) {
                this.addUniqueOffer(cachedOffers, parsed);
                summary.criteriaMatched!++;
            }
        }

        this.logCachedSnapshotSummary(job, snapshot, {
            ...summary,
            metadataFound,
            tokenTraits,
        });

        return cachedOffers;
    }

    private getCachedCollectionSnapshotOffers(job: BidderJob): Order[] | null {
        if (job.target.type !== "collection") {
            return null;
        }

        if (!this.collectionOfferSnapshotProvider) {
            log.debug(
                "cachedSnapshotScanSkipped",
                "Cached snapshot scan skipped because no snapshot provider is configured",
                jobLogFields(job),
            );
            return null;
        }

        const snapshot = this.collectionOfferSnapshotProvider.getSnapshot(
            job.collectionSlug,
        );
        if (!snapshot) {
            log.debug(
                "cachedSnapshotMissing",
                "Cached snapshot scan skipped because no snapshot exists",
                jobLogFields(job),
            );
            return null;
        }

        return this.collectCachedCollectionSnapshotOffers(job, snapshot);
    }

    private collectCachedCollectionSnapshotOffers(
        job: BidderJob,
        snapshot: CollectionOfferSnapshot,
    ): Order[] {
        const cachedOffers: Order[] = [];
        const targetTraits =
            job.target.type === "collection"
                ? this.dedupeTraitTargets(job.target.traits ?? [])
                : [];
        const summary: SnapshotScanSummary = {
            collectionWideAdded: 0,
            exactCriteriaMatched: 0,
            explicitItemSkipped: 0,
        };

        snapshot.offers.forEach((rawOffer) => {
            if (
                this.inferNftSelectionKind(rawOffer, job.collectionAddress) ===
                "item"
            ) {
                summary.explicitItemSkipped++;
                return;
            }

            if (this.isCollectionWideOffer(rawOffer)) {
                const parsed = this.parseRawOffer(
                    rawOffer,
                    job.collectionAddress,
                    "collectionOffers",
                );
                if (parsed) {
                    this.addUniqueOffer(cachedOffers, parsed);
                    summary.collectionWideAdded++;
                }
                return;
            }

            if (targetTraits.length === 0) {
                return;
            }

            const criteriaTraits = this.normalizeOfferTraitCriteria(
                this.getOfferCriteria(rawOffer),
            );
            if (!this.matchesExactTraitTargets(criteriaTraits, targetTraits)) {
                return;
            }

            const parsed = this.parseRawOffer(
                rawOffer,
                job.collectionAddress,
                "traitOffers",
            );
            if (parsed) {
                this.addUniqueOffer(cachedOffers, parsed);
                summary.exactCriteriaMatched!++;
            }
        });

        log.debug(
            "cachedCollectionSnapshotScan",
            "Cached collection snapshot scan complete",
            {
                ...jobLogFields(job),
                snapshotOfferCount: snapshot.offers.length,
                snapshotAgeMs: Date.now() - snapshot.refreshedAt,
                collectionWideAdded: summary.collectionWideAdded,
                exactCriteriaMatched: summary.exactCriteriaMatched ?? 0,
                explicitItemSkipped: summary.explicitItemSkipped,
                targetTraits,
            },
        );

        return cachedOffers;
    }

    private logCachedSnapshotSummary(
        job: BidderJob,
        snapshot: CollectionOfferSnapshot,
        summary: SnapshotScanSummary,
    ): void {
        log.debug(
            "cachedTokenSnapshotScan",
            "Cached token snapshot scan complete",
            {
                ...jobLogFields(job),
                snapshotOfferCount: snapshot.offers.length,
                snapshotAgeMs: Date.now() - snapshot.refreshedAt,
                collectionWideAdded: summary.collectionWideAdded,
                explicitItemSkipped: summary.explicitItemSkipped,
                criteriaSeen: summary.criteriaSeen ?? 0,
                criteriaMatched: summary.criteriaMatched ?? 0,
                criteriaMismatched: summary.criteriaMismatched ?? 0,
                criteriaUntracked: summary.criteriaUntracked ?? 0,
                encodedTokenIdsMatched: summary.encodedTokenIdsMatched ?? 0,
                encodedTokenIdsSkipped: summary.encodedTokenIdsSkipped ?? 0,
                metadataFound: summary.metadataFound ?? false,
                tokenTraits: summary.tokenTraits ?? [],
                mismatchSamples: summary.mismatchSamples ?? [],
            },
        );
    }

    private dedupeTraitTargets(targets: TraitTarget[]): TraitTarget[] {
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
        criteriaTraits: TraitTarget[],
        targetTraits: TraitTarget[],
    ): boolean {
        const normalizedCriteria = this.dedupeTraitTargets(criteriaTraits);
        const normalizedTargets = this.dedupeTraitTargets(targetTraits);
        if (normalizedCriteria.length !== normalizedTargets.length) {
            return false;
        }

        const targetKeys = new Set(
            normalizedTargets.map((target) => `${target.type}|${target.value}`),
        );
        return normalizedCriteria.every((criterion) =>
            targetKeys.has(`${criterion.type}|${criterion.value}`),
        );
    }

    private isCollectionWideOffer(rawOffer: unknown): boolean {
        return isOpenSeaCollectionWideOffer(rawOffer);
    }

    private async fetchAllCollectionOffers(
        collectionSlug: string,
        context: BiddingServiceRequestContext = {},
    ): Promise<unknown[]> {
        let cursor: string | undefined;
        const seenCursors = new Set<string>();
        const allOffers: unknown[] = [];

        while (true) {
            const response = await this.withRetry(
                "getCollectionOffers",
                "collection offers",
                () =>
                    this.sdk.api.getCollectionOffers(
                        collectionSlug,
                        this.offersPageSize,
                        cursor,
                    ),
                context,
            );

            allOffers.push(...asArray(response?.offers));

            const next =
                typeof response?.next === "string" ? response.next : undefined;
            if (!next) {
                break;
            }
            if (seenCursors.has(next)) {
                log.error(
                    "collectionOffersPaginationLoop",
                    "Collection offers pagination loop detected",
                    { collectionSlug, cursor: next },
                );
                break;
            }

            seenCursors.add(next);
            cursor = next;
        }

        return allOffers;
    }

    private async fetchAllTraitOffers(
        collectionSlug: string,
        traitType: string,
        traitValue: string,
        context: BiddingServiceRequestContext = {},
    ): Promise<unknown[]> {
        let cursor: string | undefined;
        const seenCursors = new Set<string>();
        const allOffers: unknown[] = [];

        while (true) {
            const response = await this.withRetry(
                "getTraitOffers",
                `trait offers ${traitType}=${traitValue}`,
                () =>
                    this.sdk.api.getTraitOffers(
                        collectionSlug,
                        traitType,
                        traitValue,
                        this.offersPageSize,
                        cursor,
                    ),
                context,
            );

            allOffers.push(...asArray(response?.offers));

            const next =
                typeof response?.next === "string" ? response.next : undefined;
            if (!next) {
                break;
            }
            if (seenCursors.has(next)) {
                log.error(
                    "traitOffersPaginationLoop",
                    "Trait offers pagination loop detected",
                    {
                        collectionSlug,
                        traitType,
                        traitValue,
                        cursor: next,
                    },
                );
                break;
            }

            seenCursors.add(next);
            cursor = next;
        }

        return allOffers;
    }

    private getLiveCollectionTargetOffers(
        job: BidderJob,
        rawOffers: unknown[],
    ): Order[] {
        if (job.target.type !== "collection") {
            return [];
        }

        const offers: Order[] = [];
        const targetTraits = this.dedupeTraitTargets(job.target.traits ?? []);

        rawOffers.forEach((rawOffer) => {
            if (!this.isCollectionWideOffer(rawOffer)) {
                return;
            }

            const parsed = this.parseRawOffer(
                rawOffer,
                job.collectionAddress,
                "collectionOffers",
            );
            if (parsed) {
                this.addUniqueOffer(offers, parsed);
            }
        });

        if (targetTraits.length === 0) {
            return offers;
        }

        rawOffers.forEach((rawOffer) => {
            const criteriaTraits = this.normalizeOfferTraitCriteria(
                this.getOfferCriteria(rawOffer),
            );
            if (!this.matchesExactTraitTargets(criteriaTraits, targetTraits)) {
                return;
            }

            const parsed = this.parseRawOffer(
                rawOffer,
                job.collectionAddress,
                "traitOffers",
            );
            if (parsed) {
                this.addUniqueOffer(offers, parsed);
            }
        });

        return offers;
    }

    private async expandCompetitiveTraitSelectors(
        job: BidderJob,
        selectors: TraitSelector[],
        context: BiddingServiceRequestContext = {},
    ): Promise<TraitTarget[]> {
        const explicitTargets: TraitTarget[] = selectors
            .filter(
                (selector): selector is TraitTarget =>
                    typeof selector.value === "string",
            )
            .map((selector) => ({
                type: selector.type,
                value: selector.value,
            }));

        const typeOnlySelectors = selectors.filter(
            (selector) => selector.value === undefined,
        );
        if (typeOnlySelectors.length === 0) {
            return this.dedupeTraitTargets(explicitTargets);
        }

        let traitsResponse: unknown;
        try {
            traitsResponse = await this.withRetry(
                "getTraits",
                "collection traits",
                () => this.sdk.api.getTraits(job.collectionSlug),
                context,
            );
        } catch (error) {
            log.error(
                "typeOnlyTraitSelectorExpansionFailed",
                "Failed to expand type-only trait selectors",
                {
                    ...jobLogFields(job),
                    ...toErrorLogFields(error),
                },
            );
            return this.dedupeTraitTargets(explicitTargets);
        }

        const counts = asRecord(asRecord(traitsResponse)?.counts);
        for (const selector of typeOnlySelectors) {
            const values = Object.keys(asRecord(counts[selector.type]));
            if (values.length === 0) {
                log.info(
                    "traitSelectorValuesMissing",
                    "No trait values found for selector type",
                    {
                        ...jobLogFields(job),
                        traitType: selector.type,
                    },
                );
                continue;
            }

            values.forEach((value) =>
                explicitTargets.push({
                    type: selector.type,
                    value,
                }),
            );
        }

        return this.dedupeTraitTargets(explicitTargets);
    }

    private parseRawOffer(
        rawOffer: unknown,
        collectionAddress?: string,
        discoverySource: OfferDiscoverySource = "collectionOffers",
    ): Order | null {
        // Keep bidder runtime offer parsing centralized for snapshot projection and backend fallback reuse.
        const parsed = parseOpenSeaBiddingOffer(rawOffer, {
            collectionAddress,
            wethAddress: OPENSEA_WETH_ADDRESS,
            discoverySource,
        });
        return parsed
            ? {
                  ...parsed,
                  placedAt: parsed.createdAt ?? undefined,
              }
            : null;
    }
}

function asArray(value: unknown): unknown[] {
    return Array.isArray(value) ? value : [];
}

function jobLogFields(job: BidderJob): Record<string, unknown> {
    return {
        jobId: job.id,
        jobRef: formatBidderJobReference(job),
        collectionSlug: job.collectionSlug,
        collectionAddress: job.collectionAddress,
        targetType: job.target.type,
        tokenId: job.target.type === "token" ? job.target.tokenId : null,
    };
}

function orderLogFields(order: Order): Record<string, unknown> {
    return {
        orderId: order.id,
        maker: order.maker,
        priceWei: order.price.toString(),
        priceEth: formatUnits(order.price, 18),
        offerScope: order.offerScope ?? null,
        priceSource: order.priceSource ?? order.source ?? null,
        quantity: order.quantity?.toString() ?? "1",
        protocolAddress: order.protocolAddress ?? null,
    };
}

function asRecord(value: unknown): Record<string, unknown> {
    return value && typeof value === "object"
        ? (value as Record<string, unknown>)
        : {};
}

function stringOrUndefined(value: unknown): string | undefined {
    return typeof value === "string" ? value : undefined;
}

function nonEmptyStringOrUndefined(value: unknown): string | undefined {
    const text = stringOrUndefined(value)?.trim();
    return text && text.length > 0 ? text : undefined;
}

function requirePlacedOrderIdentity(rawOrder: unknown): {
    orderHash: string;
    protocolAddress: string;
} {
    const order = asRecord(rawOrder);
    const orderHash =
        nonEmptyStringOrUndefined(order.orderHash) ??
        nonEmptyStringOrUndefined(order.order_hash);
    const protocolAddress =
        nonEmptyStringOrUndefined(order.protocolAddress) ??
        nonEmptyStringOrUndefined(order.protocol_address);
    if (!orderHash) {
        throw new Error("OpenSea create offer response missing order hash");
    }
    if (!protocolAddress) {
        throw new Error(
            "OpenSea create offer response missing protocol address",
        );
    }
    return { orderHash, protocolAddress };
}

function getOrderHash(rawOrder: unknown): string | undefined {
    const order = asRecord(rawOrder);
    return (
        stringOrUndefined(order.orderHash) ??
        stringOrUndefined(order.order_hash)
    );
}

function matchesOrderHash(rawOrder: unknown, orderHash: string): boolean {
    return getOrderHash(rawOrder) === orderHash;
}

function isLegacyInactive(rawOrder: unknown): boolean {
    const order = asRecord(rawOrder);
    const expirationTime = Number(order.expirationTime);
    const isExpired =
        Number.isFinite(expirationTime) &&
        expirationTime > 0 &&
        expirationTime < Date.now() / 1000;

    return Boolean(
        order.cancelled || order.finalized || order.markedInvalid || isExpired,
    );
}

// isRetryableOpenSeaBiddingError separates transient provider failures from stable OpenSea validation errors.
export function isRetryableOpenSeaBiddingError(error: unknown): boolean {
    const message = toErrorMessage(error);
    return !PERMANENT_OPENSEA_ERROR_PATTERNS.some((pattern) =>
        pattern.test(message),
    );
}

function isNotFoundError(error: unknown): boolean {
    const message = toErrorMessage(error);
    const status = Number(
        asRecord(error)?.status ?? asRecord(asRecord(error)?.response)?.status,
    );
    return message.includes("404") || status === 404;
}

function isDirectOrderAbsentError(error: unknown): boolean {
    if (isNotFoundError(error)) {
        return true;
    }
    const message = toErrorMessage(error).trim().toLowerCase();
    return (
        message === "not found" ||
        /\border\b.*\bnot found\b/.test(message) ||
        /\bnot found\b.*\border\b/.test(message)
    );
}

function toErrorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}

function toRateLimitPriority(
    context: BiddingServiceRequestContext,
): TokenBucketRateLimitPriority {
    return context.priority === BIDDING_SERVICE_REQUEST_PRIORITY.UserCommand
        ? TOKEN_BUCKET_RATE_LIMIT_PRIORITY.UserCommand
        : TOKEN_BUCKET_RATE_LIMIT_PRIORITY.Background;
}
