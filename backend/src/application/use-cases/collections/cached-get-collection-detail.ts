import { DEFAULT_PAGE_LIMIT } from "@artgod/shared/config/pagination";
import { normalizeSlugRef } from "@artgod/shared/utils/ref-resolver";
import {
    QUERY_CACHE_NAMESPACES,
    type QueryCachePort,
} from "../../../ports/query-cache.js";
import {
    QUERY_CACHE_DEBUG_STATUSES,
    setCurrentQueryCacheDebugInfo,
} from "../../../utils/query-cache-debug.js";
import type {
    GetCollectionDetailInput,
    GetCollectionDetailOutput,
    GetCollectionDetailPort,
} from "./get-collection-detail.js";

type MaybePromise<T> = T | Promise<T>;

export class CachedGetCollectionDetail implements GetCollectionDetailPort {
    constructor(
        private readonly cache: QueryCachePort,
        private readonly inner: GetCollectionDetailPort,
        private readonly ttlMs: number,
    ) {}

    getCollectionDetail(
        input: GetCollectionDetailInput,
    ): MaybePromise<GetCollectionDetailOutput> {
        if (!isCollectionDetailDefaultQueryCacheEligible(input)) {
            setCurrentQueryCacheDebugInfo({
                status: QUERY_CACHE_DEBUG_STATUSES.Bypass,
            });
            return this.inner.getCollectionDetail(input);
        }

        const key = buildCollectionDetailDefaultQueryCacheKey(input);
        const cached = this.cache.getEntry<GetCollectionDetailOutput>(
            QUERY_CACHE_NAMESPACES.CollectionDetailDefault,
            key,
        );
        if (cached) {
            setCurrentQueryCacheDebugInfo({
                status: QUERY_CACHE_DEBUG_STATUSES.Hit,
                ageMs: Math.max(0, Date.now() - cached.storedAt),
                ttlMs: cached.ttlMs,
            });
            return cached.value;
        }

        setCurrentQueryCacheDebugInfo({
            status: QUERY_CACHE_DEBUG_STATUSES.Miss,
            ageMs: 0,
            ttlMs: this.ttlMs,
        });
        const result = this.inner.getCollectionDetail(input);
        if (isPromiseLike(result)) {
            return result.then((output) => {
                this.cache.set(
                    QUERY_CACHE_NAMESPACES.CollectionDetailDefault,
                    key,
                    output,
                    this.ttlMs,
                );
                return output;
            });
        }

        this.cache.set(
            QUERY_CACHE_NAMESPACES.CollectionDetailDefault,
            key,
            result,
            this.ttlMs,
        );
        return result;
    }
}

export function isCollectionDetailDefaultQueryCacheEligible(
    input: GetCollectionDetailInput,
): boolean {
    return (
        input.tokenStatus === "listed" &&
        input.limit === DEFAULT_PAGE_LIMIT &&
        !input.cursor &&
        !input.owner &&
        input.traits.length === 0 &&
        input.traitRanges.length === 0 &&
        !input.mediaMode
    );
}

export function buildCollectionDetailDefaultQueryCacheKey(
    input: GetCollectionDetailInput,
): string {
    return [
        `chain=${normalizeSlugRef(input.chainRef)}`,
        `collection=${normalizeSlugRef(input.collectionRef)}`,
        `status=${input.tokenStatus}`,
        `limit=${input.limit}`,
    ].join("|");
}

function isPromiseLike<T>(value: MaybePromise<T>): value is Promise<T> {
    return (
        typeof value === "object" &&
        value !== null &&
        "then" in value &&
        typeof value.then === "function"
    );
}
