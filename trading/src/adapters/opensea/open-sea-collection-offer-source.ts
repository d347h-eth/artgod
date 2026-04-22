import {
    CollectionOfferSource,
} from "../../application/use-cases/bidding/collection-offer-snapshot-service.js";
import {
    defaultRetryPolicy,
    RetryPolicy,
    retry,
} from "../support/retry.js";
import { TokenBucketRateLimiter } from "../support/token-bucket-rate-limiter.js";
import { biddingLog } from "../../utils/bidding-log.js";
import { OpenSeaApiClient } from "./open-sea-client.js";
import { BIDDING_DEFAULT_OPEN_SEA_OFFERS_PAGE_SIZE } from "../../config/bidding-defaults.js";

export interface OpenSeaCollectionOfferSourceOptions {
    offersPageSize?: number;
    retryPolicy?: RetryPolicy;
    rateLimiter?: TokenBucketRateLimiter;
}

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

    public async getAllOffers(collectionSlug: string): Promise<unknown[]> {
        let cursor: string | undefined;
        const seenCursors = new Set<string>();
        const allOffers: unknown[] = [];

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
                        biddingLog.info(
                            `[OpenSeaCollectionOfferSource] Failed to get all offers for ${collectionSlug} (attempt ${attempt}): ${toErrorMessage(error)}`,
                        );
                    },
                },
            );

            allOffers.push(...asArray(response?.offers));

            const next =
                typeof response?.next === "string" ? response.next : undefined;
            if (!next) {
                break;
            }

            if (seenCursors.has(next)) {
                biddingLog.error(
                    `[OpenSeaCollectionOfferSource] Pagination loop detected for ${collectionSlug}. Stopping.`,
                );
                break;
            }

            seenCursors.add(next);
            cursor = next;
        }

        return allOffers;
    }
}

function asArray(value: unknown): unknown[] {
    return Array.isArray(value) ? value : [];
}

function toErrorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}
