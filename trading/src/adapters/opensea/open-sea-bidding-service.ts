import { formatUnits } from "viem";
import {
    getOpenSeaOfferCriteria,
    inferOpenSeaNftSelectionKind,
    isOpenSeaCollectionWideOffer,
    normalizeOpenSeaOfferTraitCriteria,
    parseOpenSeaBiddingOffer,
} from "@artgod/shared/trading/open-sea-bidding-offers";
import {
    BiddingService,
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
    BIDDING_DEFAULT_OFFER_EXPIRATION_SECONDS,
    BIDDING_DEFAULT_OPEN_SEA_OFFERS_PAGE_SIZE,
    BIDDING_DEFAULT_ORDER_LOOKUP_MAX_PAGES,
    BIDDING_DEFAULT_TOKEN_CRITERIA_TRAITS_BY_COLLECTION,
} from "../../config/bidding-defaults.js";
import { biddingLog } from "../../utils/bidding-log.js";
import { defaultRetryPolicy, RetryPolicy, retry } from "../support/retry.js";
import { TokenBucketRateLimiter } from "../support/token-bucket-rate-limiter.js";
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
}

const OPENSEA_WETH_ADDRESS = "0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2";
const OPENSEA_MAINNET_CHAIN = "ethereum";

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
    }

    public async getActiveOffers(job: BidderJob): Promise<Order[]> {
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

                    // biddingLog.debug(
                    //     `[OpenSeaBiddingService] Found item offer: ${parsed.id}, Price: ${formatUnits(parsed.price, 18)} ETH, Maker: ${parsed.maker} (scope=item, priceSource=${parsed.priceSource ?? parsed.source ?? "unknown"}, qty=${parsed.quantity ?? 1n})`,
                    // );
                    this.addUniqueOffer(offers, parsed);
                }
            } catch (error) {
                biddingLog.error(
                    `[OpenSeaBiddingService] Failed to get item offers for ${formatBidderJobReference(job)}: ${toErrorMessage(error)}`,
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
                biddingLog.error(
                    `[OpenSeaBiddingService] Failed to read cached token snapshot offers: ${toErrorMessage(error)}`,
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
                    // 2c. Competitive-trait jobs stay on the live path because they need collection-wide visibility plus trait-bucket fan-out.
                    const collectionOffers =
                        await this.fetchAllCollectionOffers(job.collectionSlug);

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

                    // Expand type-only selectors into explicit trait targets before fetching each competing trait bucket.
                    const expandedTraitTargets =
                        await this.expandCompetitiveTraitSelectors(
                            job,
                            lookupTraitSelectors,
                        );
                    expandedTraitSelectorCount = expandedTraitTargets.length;
                    biddingLog.debug(
                        `[OpenSeaBiddingService] Competitive trait lookup for ${formatBidderJobReference(job)}: ${expandedTraitTargets.length} trait selector(s) resolved.`,
                    );

                    for (const traitTarget of expandedTraitTargets) {
                        // Fetch the live offers for each explicit target or competitor trait bucket.
                        const traitOffers = await this.fetchAllTraitOffers(
                            job.collectionSlug,
                            traitTarget.type,
                            traitTarget.value,
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
                biddingLog.error(
                    `[OpenSeaBiddingService] Failed to fetch collection/trait offers for ${formatBidderJobReference(job)}: ${toErrorMessage(error)}`,
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
                );

                const parsed = this.parseRawOffer(
                    bestOffer,
                    job.collectionAddress,
                    "bestOffer",
                );
                if (parsed && !offers.find((offer) => offer.id === parsed.id)) {
                    biddingLog.debug(
                        `[OpenSeaBiddingService] Found best offer for ${formatBidderJobReference(job)}: ${parsed.id}, Price: ${formatUnits(parsed.price, 18)} ETH, Maker: ${parsed.maker} (scope=${parsed.offerScope ?? "unknown"}, priceSource=${parsed.priceSource ?? parsed.source ?? "unknown"}, qty=${parsed.quantity ?? 1n})`,
                    );
                    offers.push(parsed);
                }
            } catch (error) {
                if (!isNotFoundError(error)) {
                    biddingLog.error(
                        `[OpenSeaBiddingService] Failed to get best offer for ${formatBidderJobReference(job)}: ${toErrorMessage(error)}`,
                    );
                    throw error;
                }
            }
        }

        if (isCompetitiveTraitJob) {
            biddingLog.debug(
                `[OpenSeaBiddingService] Competitive trait buckets for ${formatBidderJobReference(job)}: CollectionWide=${competitiveBucketCounts.collectionWide.size}, TargetTrait=${competitiveBucketCounts.targetTrait.size}, CompetitorTraits=${competitiveBucketCounts.competitorTraits.size}, SelectorsRequested=${lookupTraitSelectors.length}, SelectorsExpanded=${expandedTraitSelectorCount}, TrackedTotal=${offers.length}`,
            );
        }

        return offers.sort((left, right) =>
            left.price > right.price ? -1 : 1,
        );
    }

    public async getActiveTokenOfferByMaker(
        job: BidderJob,
        makerAddress: string,
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
            biddingLog.error(
                `[OpenSeaBiddingService] Failed to get active token offer by maker: ${toErrorMessage(error)}`,
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
    ): Promise<Order | null> {
        let foundOrder: unknown = null;

        if (protocolAddress) {
            try {
                biddingLog.debug(
                    `[OpenSeaBiddingService] Fetching order ${orderHash} via getOrderByHash...`,
                );
                const response = await this.withRetry(
                    "getOrderByHash",
                    "order by hash",
                    () =>
                        this.sdk.api.getOrderByHash(orderHash, protocolAddress),
                );

                if (matchesOrderHash(response, orderHash)) {
                    foundOrder = response;
                    biddingLog.debug(
                        `[OpenSeaBiddingService] Found order ${orderHash} via direct lookup.`,
                    );
                }
            } catch (error) {
                biddingLog.debug(
                    `[OpenSeaBiddingService] getOrderByHash failed for ${orderHash}: ${toErrorMessage(error)}`,
                );
            }
        }

        if (!foundOrder && collectionSlug) {
            biddingLog.debug(
                `[OpenSeaBiddingService] Order ${orderHash} not resolved via direct lookup. Scanning collection offers for ${collectionSlug}...`,
            );

            let cursor: string | undefined;
            let page = 0;

            while (page < this.orderLookupMaxPages) {
                try {
                    const response = await this.withRetry(
                        "getAllOffers",
                        `all offers (page ${page + 1})`,
                        () =>
                            this.sdk.api.getAllOffers(
                                collectionSlug,
                                this.offersPageSize,
                                cursor,
                            ),
                    );

                    const offers = asArray(response?.offers);
                    biddingLog.debug(
                        `[OpenSeaBiddingService] Page ${page + 1}: Fetched ${offers.length} offers for collection ${collectionSlug}.`,
                    );

                    foundOrder =
                        offers.find((offer) =>
                            matchesOrderHash(offer, orderHash),
                        ) ?? null;
                    if (foundOrder) {
                        biddingLog.debug(
                            `[OpenSeaBiddingService] Found order ${orderHash} in collection-specific offers list (Page ${page + 1}).`,
                        );
                        break;
                    }

                    const next =
                        typeof response?.next === "string"
                            ? response.next
                            : undefined;
                    if (!next) {
                        break;
                    }

                    cursor = next;
                    page++;
                } catch (error) {
                    biddingLog.debug(
                        `[OpenSeaBiddingService] Failed to fetch collection offers page ${page + 1}: ${toErrorMessage(error)}`,
                    );
                    throw error;
                }
            }
        }

        if (!foundOrder) {
            biddingLog.debug(
                `[OpenSeaBiddingService] Order ${orderHash} not found in market.`,
            );
            return null;
        }

        const parsed = this.parseRawOffer(
            foundOrder,
            collectionAddress,
            "stateRecovery",
        );
        if (!parsed) {
            return null;
        }

        const status = stringOrUndefined(
            asRecord(foundOrder)?.status,
        )?.toLowerCase();
        if (status) {
            if (status !== "active") {
                biddingLog.debug(
                    `[OpenSeaBiddingService] Recovered order ${orderHash} is not active (status=${status}).`,
                );
                return null;
            }

            biddingLog.debug(
                `[OpenSeaBiddingService] Successfully recovered order ${orderHash}. Status: ${status}`,
            );
            return parsed;
        }

        if (isLegacyInactive(foundOrder)) {
            biddingLog.debug(
                `[OpenSeaBiddingService] Recovered order ${orderHash} is not active (legacy checks failed).`,
            );
            return null;
        }

        return parsed;
    }

    public async placeOffer(
        job: BidderJob,
        amount: bigint,
    ): Promise<{
        orderHash: string;
        protocolAddress: string;
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
                );
                if (!order) {
                    throw new Error(
                        "Failed to create collection offer (no order returned)",
                    );
                }

                return {
                    orderHash:
                        stringOrUndefined(order.order_hash) ??
                        stringOrUndefined(order.orderHash) ??
                        "",
                    protocolAddress:
                        stringOrUndefined(order.protocol_address) ??
                        stringOrUndefined(order.protocolAddress) ??
                        "",
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

            const order = await this.trackSdkCall("createOffer", () =>
                this.sdk.createOffer({
                    asset: {
                        tokenAddress: job.collectionAddress,
                        tokenId: tokenTarget.tokenId,
                    },
                    accountAddress: this.makerAddress,
                    amount: formatUnits(amount, 18),
                    expirationTime,
                }),
            );

            return {
                orderHash:
                    stringOrUndefined(order.orderHash) ??
                    stringOrUndefined(order.order_hash) ??
                    "",
                protocolAddress:
                    stringOrUndefined(order.protocolAddress) ??
                    stringOrUndefined(order.protocol_address) ??
                    "",
                expirationTime:
                    this.tryParseNumber(
                        order.expiration_time ?? order.expirationTime,
                    ) ?? expirationTime,
            };
        } catch (error) {
            biddingLog.error(
                `[OpenSeaBiddingService] Failed to place offer: ${toErrorMessage(error)}`,
            );
            throw error;
        }
    }

    public async cancelOffer(_job: BidderJob, order: Order): Promise<void> {
        try {
            if (!order.protocolAddress) {
                throw new Error(
                    "Missing protocolAddress for offchain cancellation",
                );
            }

            await retry(
                async () => {
                    await this.trackSdkCall("offchainCancelOrder", () =>
                        this.sdk.offchainCancelOrder(
                            order.protocolAddress!,
                            order.id,
                            OPENSEA_MAINNET_CHAIN,
                            undefined,
                            true,
                        ),
                    );
                },
                this.retryPolicy,
                {
                    onRetry: ({ attempt, error }) => {
                        biddingLog.info(
                            `[OpenSeaBiddingService] Failed to cancel offer ${order.id} (attempt ${attempt}): ${toErrorMessage(error)}`,
                        );
                    },
                },
            );
        } catch (error) {
            biddingLog.error(
                `[OpenSeaBiddingService] Failed to cancel offer ${order.id} after retries: ${toErrorMessage(error)}`,
            );
            throw error;
        }
    }

    private async trackSdkCall<T>(
        action: string,
        fn: () => Promise<T>,
    ): Promise<T> {
        const cost = sdkCallCosts[action] ?? { get: 1, post: 0 };
        await this.rateLimiter.wait(cost.get, cost.post);
        return await fn();
    }

    private async withRetry<T>(
        action: string,
        logLabel: string,
        fn: () => Promise<T>,
    ): Promise<T> {
        return await retry(
            async () => await this.trackSdkCall(action, fn),
            this.retryPolicy,
            {
                onRetry: ({ attempt, error }) => {
                    biddingLog.info(
                        `[OpenSeaBiddingService] Failed to get ${logLabel} (attempt ${attempt}): ${toErrorMessage(error)}`,
                    );
                },
            },
        );
    }

    private async fetchNftOffers(
        collectionSlug: string,
        tokenId: string,
        logLabel: string,
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
            );

            offers.push(...asArray(response?.offers));

            const next =
                typeof response?.next === "string" ? response.next : undefined;
            if (!next) {
                break;
            }

            if (seenCursors.has(next)) {
                biddingLog.error(
                    `[OpenSeaBiddingService] NFT offer pagination loop detected for ${collectionSlug}#${tokenId}. Stopping.`,
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

    private parseTokenMetadataTraits(metadataJson: string): TraitTarget[] {
        try {
            const parsed = JSON.parse(metadataJson);
            if (!Array.isArray(parsed)) {
                return [];
            }

            return parsed.flatMap((entry: unknown) => {
                const type =
                    stringOrUndefined(asRecord(entry)?.traitType) ??
                    stringOrUndefined(asRecord(entry)?.trait_type) ??
                    stringOrUndefined(asRecord(entry)?.type);
                const value = asRecord(entry)?.value;

                if (
                    typeof type !== "string" ||
                    value === undefined ||
                    value === null
                ) {
                    return [];
                }

                return [{ type, value: String(value) }];
            });
        } catch (error) {
            biddingLog.error(
                `[OpenSeaBiddingService] Failed to parse cached token metadata: ${toErrorMessage(error)}`,
            );
            return [];
        }
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
                    biddingLog.debug(
                        `[OpenSeaBiddingService] Failed to parse encoded_token_ids range "${segment}" while matching token ${tokenId}`,
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
                biddingLog.debug(
                    `[OpenSeaBiddingService] Failed to parse encoded_token_ids value "${segment}" while matching token ${tokenId}`,
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
            biddingLog.debug(
                `[OpenSeaBiddingService] Cached snapshot scan skipped for ${formatBidderJobReference(job)}: no snapshot provider configured`,
            );
            return [];
        }

        const snapshot = this.collectionOfferSnapshotProvider.getSnapshot(
            job.collectionSlug,
        );
        if (!snapshot) {
            biddingLog.debug(
                `[OpenSeaBiddingService] Cached snapshot scan skipped for ${formatBidderJobReference(job)}: no snapshot for ${job.collectionSlug}`,
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
            const metadataJson =
                await this.tokenMetadataRepository!.getMetadata(
                    job.collectionSlug,
                    tokenTarget.tokenId,
                );
            if (metadataJson) {
                metadataFound = true;
                tokenTraits = this.parseTokenMetadataTraits(metadataJson);
            }
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
            biddingLog.debug(
                `[OpenSeaBiddingService] Cached snapshot scan skipped for ${formatBidderJobReference(job)}: no snapshot provider configured`,
            );
            return null;
        }

        const snapshot = this.collectionOfferSnapshotProvider.getSnapshot(
            job.collectionSlug,
        );
        if (!snapshot) {
            biddingLog.debug(
                `[OpenSeaBiddingService] Cached snapshot scan skipped for ${formatBidderJobReference(job)}: no snapshot for ${job.collectionSlug}`,
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

        biddingLog.debug(
            `[OpenSeaBiddingService] Cached snapshot scan for ${formatBidderJobReference(job)}: snapshotTotal=${snapshot.offers.length}, snapshotAgeMs=${Date.now() - snapshot.refreshedAt}, collectionWideAdded=${summary.collectionWideAdded}, exactCriteriaMatched=${summary.exactCriteriaMatched}, explicitItemSkipped=${summary.explicitItemSkipped}, targetTraits=${this.formatTraitTargetsForLog(targetTraits)}`,
        );

        return cachedOffers;
    }

    private logCachedSnapshotSummary(
        job: BidderJob,
        snapshot: CollectionOfferSnapshot,
        summary: SnapshotScanSummary,
    ): void {
        biddingLog.debug(
            `[OpenSeaBiddingService] Cached snapshot scan for ${formatBidderJobReference(job)}: snapshotTotal=${snapshot.offers.length}, snapshotAgeMs=${Date.now() - snapshot.refreshedAt}, collectionWideAdded=${summary.collectionWideAdded}, explicitItemSkipped=${summary.explicitItemSkipped}, criteriaSeen=${summary.criteriaSeen ?? 0}, criteriaMatched=${summary.criteriaMatched ?? 0}, criteriaMismatched=${summary.criteriaMismatched ?? 0}, criteriaUntracked=${summary.criteriaUntracked ?? 0}, encodedTokenIdsMatched=${summary.encodedTokenIdsMatched ?? 0}, encodedTokenIdsSkipped=${summary.encodedTokenIdsSkipped ?? 0}, metadataFound=${summary.metadataFound ?? false}, tokenTraits=${this.formatTraitTargetsForLog(summary.tokenTraits ?? [])}${summary.mismatchSamples && summary.mismatchSamples.length > 0 ? `, mismatchSamples=${summary.mismatchSamples.join(",")}` : ""}`,
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
            );

            allOffers.push(...asArray(response?.offers));

            const next =
                typeof response?.next === "string" ? response.next : undefined;
            if (!next) {
                break;
            }
            if (seenCursors.has(next)) {
                biddingLog.error(
                    `[OpenSeaBiddingService] Collection offers pagination loop detected for ${collectionSlug}. Stopping.`,
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
            );

            allOffers.push(...asArray(response?.offers));

            const next =
                typeof response?.next === "string" ? response.next : undefined;
            if (!next) {
                break;
            }
            if (seenCursors.has(next)) {
                biddingLog.error(
                    `[OpenSeaBiddingService] Trait offers pagination loop detected for ${collectionSlug} (${traitType}=${traitValue}). Stopping.`,
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
            );
        } catch (error) {
            biddingLog.error(
                `[OpenSeaBiddingService] Failed to expand type-only trait selectors for ${formatBidderJobReference(job)}: ${toErrorMessage(error)}`,
            );
            return this.dedupeTraitTargets(explicitTargets);
        }

        const counts = asRecord(asRecord(traitsResponse)?.counts);
        for (const selector of typeOnlySelectors) {
            const values = Object.keys(asRecord(counts[selector.type]));
            if (values.length === 0) {
                biddingLog.info(
                    `[OpenSeaBiddingService] No trait values found for selector type "${selector.type}" in collection ${job.collectionSlug}.`,
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
        return parseOpenSeaBiddingOffer(rawOffer, {
            collectionAddress,
            wethAddress: OPENSEA_WETH_ADDRESS,
            discoverySource,
        });
    }
}

function asArray(value: unknown): unknown[] {
    return Array.isArray(value) ? value : [];
}

function asRecord(value: unknown): Record<string, unknown> {
    return value && typeof value === "object"
        ? (value as Record<string, unknown>)
        : {};
}

function stringOrUndefined(value: unknown): string | undefined {
    return typeof value === "string" ? value : undefined;
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

function isNotFoundError(error: unknown): boolean {
    const message = toErrorMessage(error);
    const status = Number(
        asRecord(error)?.status ?? asRecord(asRecord(error)?.response)?.status,
    );
    return message.includes("404") || status === 404;
}

function toErrorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}
