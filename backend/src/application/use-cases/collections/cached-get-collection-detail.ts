import { logger } from "@artgod/shared/utils";
import { DEFAULT_PAGE_LIMIT } from "@artgod/shared/config/pagination";
import { normalizeSlugRef } from "@artgod/shared/utils/ref-resolver";
import type { CollectionMediaState } from "@artgod/shared/types/browse";
import {
    markCurrentQueryCacheBypass,
    markCurrentQueryCacheHit,
    markCurrentQueryCacheMiss,
} from "../../../utils/query-cache-debug.js";
import type { TokenPreviewWarmupPort } from "./cached-get-token-preview.js";
import type {
    GetCollectionDetailInput,
    GetCollectionDetailOutput,
    GetCollectionDetailPort,
} from "./get-collection-detail.js";

export type PublicCollectionDetailCacheOptions = {
    defaultInput: GetCollectionDetailInput;
    refreshMs: number;
    previewWarmRefreshMs: number;
};

type PublicCollectionDefaultMediaModePort = {
    getDefaultMediaMode():
        | CollectionMediaState["defaultMode"]
        | Promise<CollectionMediaState["defaultMode"]>;
};

type CollectionDetailCacheEntry = {
    output: GetCollectionDetailOutput;
    storedAt: number;
};

export class PublicCollectionDetailCache implements GetCollectionDetailPort {
    private readonly refreshMs: number;
    private readonly previewWarmRefreshMs: number;
    private readonly defaultInput: GetCollectionDetailInput;
    private cachedEntry: CollectionDetailCacheEntry | null = null;
    private refreshTimer: ReturnType<typeof setInterval> | null = null;
    private refreshInFlight: Promise<GetCollectionDetailOutput> | null = null;
    private lastPreviewWarmupAt: number | null = null;
    private defaultMediaMode: CollectionMediaState["defaultMode"] | null = null;

    constructor(
        private readonly inner: GetCollectionDetailPort,
        private readonly defaultMediaModePort: PublicCollectionDefaultMediaModePort,
        private readonly tokenPreviewWarmupPort: TokenPreviewWarmupPort | null,
        options: PublicCollectionDetailCacheOptions,
    ) {
        this.defaultInput = options.defaultInput;
        this.refreshMs = Math.max(1, options.refreshMs);
        this.previewWarmRefreshMs = Math.max(1, options.previewWarmRefreshMs);
    }

    start(): void {
        if (this.refreshTimer) {
            return;
        }

        this.scheduleBackgroundRefresh();
        this.refreshTimer = setInterval(() => {
            this.scheduleBackgroundRefresh();
        }, this.refreshMs);
        this.refreshTimer.unref?.();
    }

    stop(): void {
        if (!this.refreshTimer) {
            return;
        }
        clearInterval(this.refreshTimer);
        this.refreshTimer = null;
    }

    getCollectionDetail(
        input: GetCollectionDetailInput,
    ): GetCollectionDetailOutput | Promise<GetCollectionDetailOutput> {
        if (
            !isPublicCollectionDetailCacheShapeEligible(
                input,
                this.defaultInput,
            )
        ) {
            markCurrentQueryCacheBypass();
            return this.inner.getCollectionDetail(input);
        }

        const requestMode = this.resolveRequestMode(input);
        if (isPromiseLike(requestMode)) {
            return requestMode.then((mode) =>
                this.resolveGetCollectionDetail(input, mode),
            );
        }
        return this.resolveGetCollectionDetail(input, requestMode);
    }

    private resolveGetCollectionDetail(
        input: GetCollectionDetailInput,
        requestMode: PublicCollectionRequestMode,
    ): GetCollectionDetailOutput | Promise<GetCollectionDetailOutput> {
        if (requestMode === PUBLIC_COLLECTION_REQUEST_MODES.Bypass) {
            markCurrentQueryCacheBypass();
            return this.inner.getCollectionDetail(input);
        }

        const cachedEntry = this.cachedEntry;
        if (cachedEntry) {
            markCurrentQueryCacheHit({
                storedAt: cachedEntry.storedAt,
                ttlMs: this.refreshMs,
            });
            return cachedEntry.output;
        }

        markCurrentQueryCacheMiss({ ttlMs: this.refreshMs });
        return this.refreshDefaultCollectionDetail();
    }

    private scheduleBackgroundRefresh(): void {
        void this.refreshDefaultCollectionDetail().catch((error) => {
            logger.error("Public collection detail cache refresh failed", {
                component: "PublicCollectionDetailCache",
                action: "refresh",
                chainRef: this.defaultInput.chainRef,
                collectionRef: this.defaultInput.collectionRef,
                error: String(error),
            });
        });
    }

    private refreshDefaultCollectionDetail(): Promise<GetCollectionDetailOutput> {
        const inFlight = this.refreshInFlight;
        if (inFlight) {
            return inFlight;
        }

        const refresh = Promise.resolve()
            .then(() => this.inner.getCollectionDetail(this.defaultInput))
            .then((output) => {
                const storedAt = Date.now();
                this.cachedEntry = {
                    output,
                    storedAt,
                };
                this.defaultMediaMode = output.media.defaultMode;
                this.maybeWarmTokenPreviews(output, storedAt);
                return output;
            })
            .finally(() => {
                this.refreshInFlight = null;
            });

        this.refreshInFlight = refresh;
        return refresh;
    }

    private maybeWarmTokenPreviews(
        output: GetCollectionDetailOutput,
        refreshedAt: number,
    ): void {
        if (!this.tokenPreviewWarmupPort) {
            return;
        }
        if (
            this.lastPreviewWarmupAt !== null &&
            refreshedAt - this.lastPreviewWarmupAt < this.previewWarmRefreshMs
        ) {
            return;
        }

        this.lastPreviewWarmupAt = refreshedAt;
        this.tokenPreviewWarmupPort.warmTokenPreviews({
            chainRef: this.defaultInput.chainRef,
            collectionRef: this.defaultInput.collectionRef,
            mediaMode: output.media.defaultMode,
            tokenRefs: output.tokens.items.map((token) => token.tokenId),
        });
    }

    private resolveRequestMode(
        input: GetCollectionDetailInput,
    ): PublicCollectionRequestMode | Promise<PublicCollectionRequestMode> {
        if (input.mediaPreference) {
            return PUBLIC_COLLECTION_REQUEST_MODES.Bypass;
        }
        if (!input.mediaMode) {
            return PUBLIC_COLLECTION_REQUEST_MODES.Canonical;
        }

        const defaultMediaMode = this.resolveDefaultMediaMode();
        if (isPromiseLike(defaultMediaMode)) {
            return defaultMediaMode.then((resolvedMode) =>
                input.mediaMode === resolvedMode
                    ? PUBLIC_COLLECTION_REQUEST_MODES.Canonical
                    : PUBLIC_COLLECTION_REQUEST_MODES.Bypass,
            );
        }

        return input.mediaMode === defaultMediaMode
            ? PUBLIC_COLLECTION_REQUEST_MODES.Canonical
            : PUBLIC_COLLECTION_REQUEST_MODES.Bypass;
    }

    private resolveDefaultMediaMode():
        | CollectionMediaState["defaultMode"]
        | Promise<CollectionMediaState["defaultMode"]> {
        if (this.defaultMediaMode) {
            return this.defaultMediaMode;
        }

        const defaultMediaMode =
            this.defaultMediaModePort.getDefaultMediaMode();
        if (isPromiseLike(defaultMediaMode)) {
            return defaultMediaMode.then((resolvedMode) => {
                this.defaultMediaMode = resolvedMode;
                return resolvedMode;
            });
        }

        this.defaultMediaMode = defaultMediaMode;
        return defaultMediaMode;
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
        !input.mediaMode &&
        !input.mediaPreference
    );
}

export function isPublicCollectionDetailCacheEligible(
    input: GetCollectionDetailInput,
    defaultInput: GetCollectionDetailInput,
): boolean {
    return (
        isCollectionDetailDefaultQueryCacheEligible(input) &&
        buildCollectionDetailDefaultQueryCacheKey(input) ===
            buildCollectionDetailDefaultQueryCacheKey(defaultInput)
    );
}

function isPublicCollectionDetailCacheShapeEligible(
    input: GetCollectionDetailInput,
    defaultInput: GetCollectionDetailInput,
): boolean {
    return (
        isCollectionDetailDefaultQueryCacheShapeEligible(input) &&
        buildCollectionDetailDefaultQueryCacheKey(input) ===
            buildCollectionDetailDefaultQueryCacheKey(defaultInput)
    );
}

function isCollectionDetailDefaultQueryCacheShapeEligible(
    input: GetCollectionDetailInput,
): boolean {
    return (
        input.tokenStatus === "listed" &&
        input.limit === DEFAULT_PAGE_LIMIT &&
        !input.cursor &&
        !input.owner &&
        input.traits.length === 0 &&
        input.traitRanges.length === 0 &&
        !input.mediaPreference
    );
}

const PUBLIC_COLLECTION_REQUEST_MODES = {
    Canonical: "canonical",
    Bypass: "bypass",
} as const;

type PublicCollectionRequestMode =
    (typeof PUBLIC_COLLECTION_REQUEST_MODES)[keyof typeof PUBLIC_COLLECTION_REQUEST_MODES];

function isPromiseLike<T>(value: T | Promise<T>): value is Promise<T> {
    return (
        typeof value === "object" &&
        value !== null &&
        "then" in value &&
        typeof value.then === "function"
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
