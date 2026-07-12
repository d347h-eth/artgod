import { normalizeSlugRef } from "@artgod/shared/utils/ref-resolver";
import {
    QUERY_CACHE_NAMESPACES,
    type QueryCachePort,
} from "../../../ports/query-cache.js";
import {
    markCurrentQueryCacheBypass,
    markCurrentQueryCacheHit,
    markCurrentQueryCacheMiss,
} from "../../../utils/query-cache-debug.js";
import type {
    GetTokenPreviewInput,
    GetTokenPreviewOutput,
    GetTokenPreviewPort,
} from "./get-token-preview.js";
import {
    COLLECTION_MEDIA_MODES,
    type CollectionMediaPreferenceValue,
} from "@artgod/shared/extensions";

type MaybePromise<T> = T | Promise<T>;

// Names an omitted media query dimension inside preview cache keys.
const OMITTED_MEDIA_QUERY_CACHE_KEY = "default";

export type WarmTokenPreviewEntriesInput = {
    chainRef: string;
    collectionRef: string;
    tokenRefs: string[];
    mediaMode?: string;
    mediaPreference?: CollectionMediaPreferenceValue;
};

export type TokenPreviewWarmupPort = {
    warmTokenPreviews(input: WarmTokenPreviewEntriesInput): void;
};

type CachedGetTokenPreviewOptions = {
    freshMs: number;
    staleMs: number;
    warmupConcurrency: number;
};

export class CachedGetTokenPreview
    implements GetTokenPreviewPort, TokenPreviewWarmupPort
{
    private readonly freshMs: number;
    private readonly staleMs: number;
    private readonly warmupConcurrency: number;
    private readonly refreshInFlight = new Map<string, Promise<void>>();
    private readonly warmupInFlight = new Map<string, Promise<void>>();

    constructor(
        private readonly cache: QueryCachePort,
        private readonly inner: GetTokenPreviewPort,
        options: CachedGetTokenPreviewOptions,
    ) {
        this.freshMs = Math.max(1, options.freshMs);
        this.staleMs = Math.max(this.freshMs, options.staleMs);
        this.warmupConcurrency = Math.max(1, options.warmupConcurrency);
    }

    getTokenPreview(
        input: GetTokenPreviewInput,
    ): MaybePromise<GetTokenPreviewOutput> {
        const key = buildTokenPreviewDefaultQueryCacheKey(input);
        const cached = this.cache.getEntry<GetTokenPreviewOutput>(
            QUERY_CACHE_NAMESPACES.TokenPreviewDefault,
            key,
        );
        if (
            cached &&
            isTokenPreviewDefaultCacheEntryEligible(input, cached.value)
        ) {
            const now = Date.now();
            const ageMs = Math.max(0, now - cached.storedAt);
            markCurrentQueryCacheHit({
                storedAt: cached.storedAt,
                ttlMs: this.staleMs,
                now,
            });
            if (ageMs > this.freshMs) {
                this.scheduleRefresh(key, input);
            }
            return cached.value;
        }
        if (cached) {
            this.cache.delete(QUERY_CACHE_NAMESPACES.TokenPreviewDefault, key);
        }

        const result = this.inner.getTokenPreview(input);
        if (isPromiseLike(result)) {
            return result.then((output) =>
                this.finalizeColdLoad(key, input, output),
            );
        }

        return this.finalizeColdLoad(key, input, result);
    }

    warmTokenPreviews(input: WarmTokenPreviewEntriesInput): void {
        const tokenRefs = uniqueTokenRefs(input.tokenRefs);
        if (tokenRefs.length === 0) {
            return;
        }

        const warmupKey = buildTokenPreviewWarmupKey({
            chainRef: input.chainRef,
            collectionRef: input.collectionRef,
            mediaMode: input.mediaMode,
            mediaPreference: input.mediaPreference,
        });
        if (this.warmupInFlight.has(warmupKey)) {
            return;
        }

        const promise = new Promise<void>((resolve) => {
            setTimeout(() => {
                void this.runWarmup({ ...input, tokenRefs })
                    .catch(() => undefined)
                    .finally(resolve);
            }, 0);
        }).finally(() => {
            this.warmupInFlight.delete(warmupKey);
        });

        this.warmupInFlight.set(warmupKey, promise);
    }

    private finalizeColdLoad(
        key: string,
        input: GetTokenPreviewInput,
        output: GetTokenPreviewOutput,
    ): GetTokenPreviewOutput {
        if (!isTokenPreviewDefaultCacheEntryEligible(input, output)) {
            markCurrentQueryCacheBypass();
            return output;
        }

        this.cache.set(
            QUERY_CACHE_NAMESPACES.TokenPreviewDefault,
            key,
            output,
            this.staleMs,
        );
        markCurrentQueryCacheMiss({ ttlMs: this.staleMs });
        return output;
    }

    private scheduleRefresh(key: string, input: GetTokenPreviewInput): void {
        if (this.refreshInFlight.has(key)) {
            return;
        }

        setTimeout(() => {
            void this.refreshEntry(key, input);
        }, 0);
    }

    private async runWarmup(
        input: WarmTokenPreviewEntriesInput,
    ): Promise<void> {
        const workers = Array.from(
            {
                length: Math.min(
                    this.warmupConcurrency,
                    input.tokenRefs.length,
                ),
            },
            () => this.runWarmupWorker(input),
        );
        await Promise.all(workers);
    }

    private async runWarmupWorker(
        input: WarmTokenPreviewEntriesInput,
    ): Promise<void> {
        while (input.tokenRefs.length > 0) {
            const tokenRef = input.tokenRefs.shift();
            if (!tokenRef) {
                return;
            }
            const entryInput: GetTokenPreviewInput = {
                chainRef: input.chainRef,
                collectionRef: input.collectionRef,
                tokenRef,
                mediaMode: input.mediaMode,
                mediaPreference: input.mediaPreference,
            };
            const key = buildTokenPreviewDefaultQueryCacheKey(entryInput);
            const cached = this.cache.getEntry<GetTokenPreviewOutput>(
                QUERY_CACHE_NAMESPACES.TokenPreviewDefault,
                key,
            );
            if (cached) {
                const ageMs = Math.max(0, Date.now() - cached.storedAt);
                if (ageMs <= this.freshMs) {
                    continue;
                }
            }
            await this.refreshEntry(key, entryInput);
        }
    }

    private async refreshEntry(
        key: string,
        input: GetTokenPreviewInput,
    ): Promise<void> {
        const existing = this.refreshInFlight.get(key);
        if (existing) {
            return existing;
        }

        const refresh = Promise.resolve()
            .then(() => this.inner.getTokenPreview(input))
            .then((output) => {
                if (!isTokenPreviewDefaultCacheEntryEligible(input, output)) {
                    this.cache.delete(
                        QUERY_CACHE_NAMESPACES.TokenPreviewDefault,
                        key,
                    );
                    return;
                }
                this.cache.set(
                    QUERY_CACHE_NAMESPACES.TokenPreviewDefault,
                    key,
                    output,
                    this.staleMs,
                );
            })
            .finally(() => {
                this.refreshInFlight.delete(key);
            });

        this.refreshInFlight.set(key, refresh);
        return refresh;
    }
}

export function buildTokenPreviewDefaultQueryCacheKey(
    input: GetTokenPreviewInput,
): string {
    return [
        `chain=${normalizeSlugRef(input.chainRef)}`,
        `collection=${normalizeSlugRef(input.collectionRef)}`,
        `token=${input.tokenRef.trim()}`,
        `mode=${normalizeMediaModeCacheKey(input.mediaMode)}`,
        `preference=${normalizeMediaPreferenceCacheKey(input.mediaPreference)}`,
        `variant=${normalizeMediaVariantCacheKey(input.mediaVariant)}`,
    ].join("|");
}

export function isTokenPreviewDefaultCacheEligible(
    output: GetTokenPreviewOutput,
): boolean {
    return (
        output.media.selectedMode === COLLECTION_MEDIA_MODES.Snapshot &&
        output.media.selectedMode === output.media.defaultMode &&
        output.media.selectedVariant === output.media.defaultVariant
    );
}

function isTokenPreviewDefaultCacheEntryEligible(
    input: GetTokenPreviewInput,
    output: GetTokenPreviewOutput,
): boolean {
    if (!isTokenPreviewDefaultCacheEligible(output)) {
        return false;
    }
    const requestedMode = normalizeMediaModeCacheKey(input.mediaMode);
    if (requestedMode === OMITTED_MEDIA_QUERY_CACHE_KEY) {
        return true;
    }
    return (
        requestedMode === normalizeMediaModeCacheKey(output.media.selectedMode)
    );
}

function buildTokenPreviewWarmupKey(params: {
    chainRef: string;
    collectionRef: string;
    mediaMode?: string;
    mediaPreference?: CollectionMediaPreferenceValue;
}): string {
    return [
        normalizeSlugRef(params.chainRef),
        normalizeSlugRef(params.collectionRef),
        normalizeMediaModeCacheKey(params.mediaMode),
        normalizeMediaPreferenceCacheKey(params.mediaPreference),
    ].join("|");
}

function normalizeMediaPreferenceCacheKey(
    mediaPreference: string | undefined,
): string {
    const normalized = mediaPreference?.trim().toLowerCase();
    return normalized && normalized.length > 0
        ? normalized
        : OMITTED_MEDIA_QUERY_CACHE_KEY;
}

function normalizeMediaVariantCacheKey(
    mediaVariant: string | undefined,
): string {
    const normalized = mediaVariant?.trim().toLowerCase();
    return normalized && normalized.length > 0
        ? normalized
        : OMITTED_MEDIA_QUERY_CACHE_KEY;
}

function normalizeMediaModeCacheKey(mediaMode: string | undefined): string {
    const normalized = mediaMode?.trim().toLowerCase();
    return normalized && normalized.length > 0
        ? normalized
        : OMITTED_MEDIA_QUERY_CACHE_KEY;
}

function uniqueTokenRefs(tokenRefs: string[]): string[] {
    const seen = new Set<string>();
    const unique: string[] = [];
    for (const tokenRef of tokenRefs) {
        const normalized = tokenRef.trim();
        if (!normalized || seen.has(normalized)) {
            continue;
        }
        seen.add(normalized);
        unique.push(normalized);
    }
    return unique;
}

function isPromiseLike<T>(value: MaybePromise<T>): value is Promise<T> {
    return (
        typeof value === "object" &&
        value !== null &&
        "then" in value &&
        typeof value.then === "function"
    );
}
