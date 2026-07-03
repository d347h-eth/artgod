import type {
    CollectionOfferSource,
    CollectionOfferSourceResult,
} from "../../application/use-cases/bidding/collection-offer-snapshot-service.js";
import {
    defaultRetryPolicy,
    RetryPolicy,
    retry,
} from "../support/retry.js";
import { TokenBucketRateLimiter } from "../support/token-bucket-rate-limiter.js";
import {
    BIDDING_LOG_COMPONENT,
    createBiddingComponentLogger,
    toErrorLogFields,
} from "../../utils/bidding-log.js";
import { OpenSeaApiClient } from "./open-sea-client.js";
import { BIDDING_DEFAULT_OPEN_SEA_OFFERS_PAGE_SIZE } from "../../config/bidding-defaults.js";

export interface OpenSeaCollectionOfferSourceOptions {
    offersPageSize?: number;
    retryPolicy?: RetryPolicy;
    rateLimiter?: TokenBucketRateLimiter;
}

const log = createBiddingComponentLogger(
    BIDDING_LOG_COMPONENT.OpenSeaCollectionOfferSource,
);

const OPEN_SEA_COLLECTION_OFFER_SOURCE_LOG_ACTION = {
    GetAllOffersComplete: "getAllOffersComplete",
    GetAllOffersRetry: "getAllOffersRetry",
    PaginationLoopDetected: "paginationLoopDetected",
} as const;

// OpenSeaCollectionOfferSource is the snapshot lane adapter used by the shared collection offer cache.
export class OpenSeaCollectionOfferSource implements CollectionOfferSource {
    private readonly offersPageSize: number;
    private readonly retryPolicy: RetryPolicy;
    private readonly rateLimiter: TokenBucketRateLimiter;

    constructor(
        private readonly api: OpenSeaApiClient,
        options: OpenSeaCollectionOfferSourceOptions = {},
    ) {
        this.offersPageSize = Math.max(
            1,
            options.offersPageSize ?? BIDDING_DEFAULT_OPEN_SEA_OFFERS_PAGE_SIZE,
        );
        this.retryPolicy = options.retryPolicy ?? defaultRetryPolicy;
        this.rateLimiter =
            options.rateLimiter ??
            new TokenBucketRateLimiter({
                getMax: 2,
                getRefillPerSecond: 2,
                postMax: 1,
                postRefillPerSecond: 1,
            });
    }

    public async getAllOffers(
        collectionSlug: string,
    ): Promise<CollectionOfferSourceResult> {
        const startedAt = Date.now();
        let cursor: string | undefined;
        const seenCursors = new Set<string>();
        const allOffers: unknown[] = [];
        const priceStats = new OfferPriceStats();
        let pageCount = 0;
        let finalCursor: string | null = null;

        while (true) {
            const response = await retry(
                async () => {
                    await this.rateLimiter.wait(1, 0);
                    return await this.api.getAllOffers(
                        collectionSlug,
                        this.offersPageSize,
                        cursor,
                    );
                },
                this.retryPolicy,
                {
                    onRetry: ({ attempt, error }) => {
                        log.info(
                            OPEN_SEA_COLLECTION_OFFER_SOURCE_LOG_ACTION.GetAllOffersRetry,
                            "Retrying OpenSea all-offers request",
                            {
                                collectionSlug,
                                attempt,
                                ...toErrorLogFields(error),
                            },
                        );
                    },
                },
            );

            const pageOffers = asArray(response?.offers);
            pageCount += 1;
            allOffers.push(...pageOffers);
            pageOffers.forEach((offer) => priceStats.record(offer));

            const next =
                typeof response?.next === "string" ? response.next : undefined;
            if (!next) {
                finalCursor = cursor ?? null;
                break;
            }

            if (seenCursors.has(next)) {
                log.error(
                    OPEN_SEA_COLLECTION_OFFER_SOURCE_LOG_ACTION.PaginationLoopDetected,
                    "OpenSea all-offers pagination loop detected",
                    {
                        collectionSlug,
                        cursor: next,
                    },
                );
                finalCursor = next;
                break;
            }

            seenCursors.add(next);
            cursor = next;
        }

        const durationMs = Date.now() - startedAt;
        const metrics = {
            durationMs,
            pageCount,
            offerCount: allOffers.length,
            firstPriceWei: priceStats.firstPriceWei,
            lastPriceWei: priceStats.lastPriceWei,
            minPriceWei: priceStats.minPriceWei,
            maxPriceWei: priceStats.maxPriceWei,
            finalCursor,
        };
        log.debug(
            OPEN_SEA_COLLECTION_OFFER_SOURCE_LOG_ACTION.GetAllOffersComplete,
            "Fetched OpenSea all-offers snapshot",
            {
                collectionSlug,
                ...metrics,
            },
        );

        return {
            offers: allOffers,
            metrics,
        };
    }
}

function asArray(value: unknown): unknown[] {
    return Array.isArray(value) ? value : [];
}

class OfferPriceStats {
    public firstPriceWei: string | null = null;
    public lastPriceWei: string | null = null;
    public minPriceWei: string | null = null;
    public maxPriceWei: string | null = null;

    public record(rawOffer: unknown): void {
        const priceWei = extractOfferPriceWei(rawOffer);
        if (!priceWei) {
            return;
        }

        if (this.firstPriceWei === null) {
            this.firstPriceWei = priceWei;
        }
        this.lastPriceWei = priceWei;
        if (
            this.minPriceWei === null ||
            BigInt(priceWei) < BigInt(this.minPriceWei)
        ) {
            this.minPriceWei = priceWei;
        }
        if (
            this.maxPriceWei === null ||
            BigInt(priceWei) > BigInt(this.maxPriceWei)
        ) {
            this.maxPriceWei = priceWei;
        }
    }
}

function extractOfferPriceWei(rawOffer: unknown): string | null {
    const candidates = collectPriceCandidates(rawOffer);
    for (const candidate of candidates) {
        if (
            typeof candidate === "string" &&
            /^(0|[1-9]\d*)$/.test(candidate)
        ) {
            return candidate;
        }
        if (
            typeof candidate === "number" &&
            Number.isSafeInteger(candidate) &&
            candidate >= 0
        ) {
            return String(candidate);
        }
        if (typeof candidate === "bigint" && candidate >= 0n) {
            return candidate.toString();
        }
    }

    return null;
}

function collectPriceCandidates(rawOffer: unknown): unknown[] {
    if (!rawOffer || typeof rawOffer !== "object") {
        return [];
    }

    const offer = rawOffer as {
        currentPrice?: unknown;
        current_price?: unknown;
        price?: {
            current?: {
                value?: unknown;
                raw?: unknown;
            };
            value?: unknown;
            raw?: unknown;
        };
    };

    return [
        offer.currentPrice,
        offer.current_price,
        offer.price?.current?.value,
        offer.price?.current?.raw,
        offer.price?.value,
        offer.price?.raw,
    ];
}
