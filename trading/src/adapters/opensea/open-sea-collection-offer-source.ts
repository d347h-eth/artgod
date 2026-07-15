import type {
    CollectionOfferSource,
    CollectionOfferSnapshotMetrics,
    CollectionOfferSourceResult,
} from "../../application/use-cases/bidding/collection-offer-snapshot-service.js";
import { CollectionOfferSourceError } from "../../application/use-cases/bidding/collection-offer-snapshot-service.js";
import { defaultRetryPolicy, RetryPolicy, retry } from "../support/retry.js";
import {
    TOKEN_BUCKET_RATE_LIMIT_PRIORITY,
    TokenBucketRateLimiter,
    type TokenBucketRateLimitPriority,
} from "../support/token-bucket-rate-limiter.js";
import {
    BIDDING_LOG_COMPONENT,
    createBiddingComponentLogger,
    toErrorLogFields,
} from "../../utils/bidding-log.js";
import { OpenSeaApiClient } from "./open-sea-client.js";
import { BIDDING_DEFAULT_OPEN_SEA_OFFERS_PAGE_SIZE } from "../../config/bidding-defaults.js";
import { observeBestEffort } from "../../utils/observe-best-effort.js";

export interface OpenSeaCollectionOfferSourceOptions {
    offersPageSize?: number;
    retryPolicy?: RetryPolicy;
    rateLimiter?: TokenBucketRateLimiter;
    observability?: OpenSeaCollectionOfferSourceObservabilityPort;
}

// Stable snapshot operation names describe the paginated OpenSea API boundary.
export const OPEN_SEA_SNAPSHOT_OPERATION = {
    GetAllOffersPage: "get_all_offers_page",
} as const;

export type OpenSeaSnapshotOperation =
    (typeof OPEN_SEA_SNAPSHOT_OPERATION)[keyof typeof OPEN_SEA_SNAPSHOT_OPERATION];

// OpenSeaCollectionOfferSourceObservabilityPort reports per-page API timing and retry pressure.
export interface OpenSeaCollectionOfferSourceObservabilityPort {
    onOpenSeaOperationFinished(input: {
        operation: OpenSeaSnapshotOperation;
        priority: TokenBucketRateLimitPriority;
        durationMs: number;
        succeeded: boolean;
    }): void;
    onOpenSeaRetry(input: {
        operation: OpenSeaSnapshotOperation;
        priority: TokenBucketRateLimitPriority;
    }): void;
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
    private readonly observability?: OpenSeaCollectionOfferSourceObservabilityPort;

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
        this.observability = options.observability;
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
        let complete = true;
        const buildMetrics = (
            snapshotComplete: boolean,
            snapshotFinalCursor: string | null,
        ): CollectionOfferSnapshotMetrics => ({
            durationMs: Date.now() - startedAt,
            pageCount,
            offerCount: allOffers.length,
            complete: snapshotComplete,
            firstPriceWei: priceStats.firstPriceWei,
            lastPriceWei: priceStats.lastPriceWei,
            minPriceWei: priceStats.minPriceWei,
            maxPriceWei: priceStats.maxPriceWei,
            finalCursor: snapshotFinalCursor,
        });

        while (true) {
            const response = await retry(
                async () => {
                    await this.rateLimiter.wait(1, 0);
                    const startedAt = Date.now();
                    let succeeded = false;
                    try {
                        const result = await this.api.getAllOffers(
                            collectionSlug,
                            this.offersPageSize,
                            cursor,
                        );
                        succeeded = true;
                        return result;
                    } finally {
                        observeBestEffort(() => {
                            this.observability?.onOpenSeaOperationFinished({
                                operation:
                                    OPEN_SEA_SNAPSHOT_OPERATION.GetAllOffersPage,
                                priority:
                                    TOKEN_BUCKET_RATE_LIMIT_PRIORITY.Background,
                                durationMs: Date.now() - startedAt,
                                succeeded,
                            });
                        });
                    }
                },
                this.retryPolicy,
                {
                    onRetry: ({ attempt, error }) => {
                        observeBestEffort(() => {
                            this.observability?.onOpenSeaRetry({
                                operation:
                                    OPEN_SEA_SNAPSHOT_OPERATION.GetAllOffersPage,
                                priority:
                                    TOKEN_BUCKET_RATE_LIMIT_PRIORITY.Background,
                            });
                        });
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
            ).catch((error: unknown) => {
                throw new CollectionOfferSourceError(
                    error instanceof Error ? error.message : String(error),
                    buildMetrics(false, cursor ?? null),
                    error,
                );
            });

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
                complete = false;
                break;
            }

            seenCursors.add(next);
            cursor = next;
        }

        const metrics = buildMetrics(complete, finalCursor);
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
        if (typeof candidate === "string" && /^(0|[1-9]\d*)$/.test(candidate)) {
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
