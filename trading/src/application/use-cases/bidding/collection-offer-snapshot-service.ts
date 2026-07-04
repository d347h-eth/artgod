import {
    BIDDING_LOG_COMPONENT,
    createBiddingComponentLogger,
    toErrorLogFields,
} from "../../../utils/bidding-log.js";
import { sleep } from "../../../utils/sleep.js";

export interface CollectionOfferSnapshot {
    collectionSlug: string;
    offers: unknown[];
    refreshedAt: number;
    metrics: CollectionOfferSnapshotMetrics;
}

export interface CollectionOfferSnapshotMetrics {
    durationMs: number;
    pageCount: number;
    offerCount: number;
    firstPriceWei: string | null;
    lastPriceWei: string | null;
    minPriceWei: string | null;
    maxPriceWei: string | null;
    finalCursor: string | null;
}

export interface CollectionOfferSourceResult {
    offers: unknown[];
    metrics: CollectionOfferSnapshotMetrics;
}

export interface CollectionOfferSource {
    getAllOffers(collectionSlug: string): Promise<CollectionOfferSourceResult>;
}

// Builds complete snapshot metric records for adapters and tests that only know a subset of telemetry fields.
export function createCollectionOfferSnapshotMetrics(
    overrides: Partial<CollectionOfferSnapshotMetrics> = {},
): CollectionOfferSnapshotMetrics {
    return {
        durationMs: 0,
        pageCount: 0,
        offerCount: 0,
        firstPriceWei: null,
        lastPriceWei: null,
        minPriceWei: null,
        maxPriceWei: null,
        finalCursor: null,
        ...overrides,
    };
}

export interface CollectionOfferSnapshotProvider {
    getSnapshot(collectionSlug: string): CollectionOfferSnapshot | null;
}

export interface CollectionOfferRefreshPort {
    requestRefresh(collectionSlug: string, reason?: string): void;
    refreshAndWait(
        collectionSlug: string,
        reason?: string,
        options?: CollectionOfferRefreshOptions,
    ): Promise<void>;
}

export interface CollectionOfferRefreshOptions {
    respectTtl?: boolean;
}

export interface CollectionOfferBootstrapProgress {
    collectionSlug: string;
    completed: number;
    total: number;
}

export interface CollectionOfferBootstrapOptions {
    onCollectionStarted?: (
        progress: CollectionOfferBootstrapProgress,
    ) => void;
    onProgress?: (progress: CollectionOfferBootstrapProgress) => void;
}

export interface CollectionOfferSnapshotObserver {
    onSnapshotRefreshed(snapshot: CollectionOfferSnapshot, reason: string): void;
}

export interface CollectionOfferSnapshotFreshnessOptions {
    maxTtlMs?: number;
    durationMultiplier?: number;
}

interface CollectionRefreshState {
    refreshing: boolean;
    pendingRequest?: PendingRefreshRequest;
    inFlightPromise?: Promise<void>;
    failureCount: number;
    lastStartedAt?: number;
    lastError?: string;
    nextEligibleRefreshAt?: number;
}

interface PendingRefreshRequest {
    reason: string;
    respectTtl: boolean;
}

const log = createBiddingComponentLogger(
    BIDDING_LOG_COMPONENT.CollectionOfferSnapshotService,
);

const COLLECTION_OFFER_SNAPSHOT_LOG_ACTION = {
    FreshSnapshotSkipped: "freshSnapshotSkipped",
    RefreshBackoffSkipped: "refreshBackoffSkipped",
    RefreshFailed: "refreshFailed",
    SnapshotRefreshStarted: "snapshotRefreshStarted",
} as const;

const COLLECTION_OFFER_SNAPSHOT_FAILURE_BACKOFF_MULTIPLIER = 2;
const COLLECTION_OFFER_SNAPSHOT_FAILURE_BACKOFF_MAX_EXPONENT = 6;
const COLLECTION_OFFER_SNAPSHOT_FAILURE_BACKOFF_JITTER_RATIO = 0.2;

// Maintains authoritative collection offer snapshots with deduped refreshes per collection.
export class CollectionOfferSnapshotService
    implements CollectionOfferSnapshotProvider, CollectionOfferRefreshPort
{
    private readonly watchedCollectionSlugs: Set<string>;
    private readonly snapshots = new Map<string, CollectionOfferSnapshot>();
    private readonly refreshStates = new Map<string, CollectionRefreshState>();
    private readonly refreshMaxTtlMs: number;
    private readonly refreshDurationMultiplier: number;
    private started = false;
    private pollTimer?: ReturnType<typeof setTimeout>;

    constructor(
        private readonly source: CollectionOfferSource,
        collectionSlugs: string[],
        private readonly pollIntervalMs: number,
        private readonly refreshTtlMs: number,
        private readonly observer?: CollectionOfferSnapshotObserver,
        freshnessOptions: CollectionOfferSnapshotFreshnessOptions = {},
    ) {
        this.watchedCollectionSlugs = new Set(collectionSlugs);
        this.refreshMaxTtlMs = Math.max(
            this.refreshTtlMs,
            freshnessOptions.maxTtlMs ?? this.refreshTtlMs,
        );
        this.refreshDurationMultiplier =
            freshnessOptions.durationMultiplier &&
            Number.isFinite(freshnessOptions.durationMultiplier) &&
            freshnessOptions.durationMultiplier > 0
                ? freshnessOptions.durationMultiplier
                : 1;
    }

    // start begins TTL-aware polling for watched collections; per-collection refreshes remain serialized.
    public start(): void {
        if (this.started) {
            return;
        }

        this.started = true;
        if (this.watchedCollectionSlugs.size > 0) {
            this.scheduleNextPoll();
        }
    }

    // stop cancels the recurring poll timer so the runtime can shut down cleanly.
    public stop(): void {
        this.started = false;
        if (this.pollTimer) {
            clearTimeout(this.pollTimer);
            this.pollTimer = undefined;
        }
    }

    // bootstrap force-builds initial snapshots for all watched collections before steady-state bidding starts.
    public async bootstrap(
        options: CollectionOfferBootstrapOptions = {},
    ): Promise<void> {
        if (this.watchedCollectionSlugs.size === 0) {
            return;
        }

        const total = this.watchedCollectionSlugs.size;
        let completed = 0;

        await Promise.all(
            Array.from(this.watchedCollectionSlugs).map((collectionSlug) => {
                options.onCollectionStarted?.({
                    collectionSlug,
                    completed,
                    total,
                });
                return this.refreshAndWait(collectionSlug, "bootstrap").then(() => {
                    completed += 1;
                    options.onProgress?.({
                        collectionSlug,
                        completed,
                        total,
                    });
                });
            }),
        );
    }

    // getSnapshot returns the latest stored snapshot immediately; it does not wait for in-flight refreshes.
    public getSnapshot(collectionSlug: string): CollectionOfferSnapshot | null {
        return this.snapshots.get(collectionSlug) ?? null;
    }

    // watchCollection adds a collection to snapshot management and starts polling it if the service is running.
    public watchCollection(collectionSlug: string): boolean {
        if (this.watchedCollectionSlugs.has(collectionSlug)) {
            return false;
        }

        this.watchedCollectionSlugs.add(collectionSlug);
        log.info("collectionWatched", "Added watched collection", {
            collectionSlug,
            watchedCollectionCount: this.watchedCollectionSlugs.size,
        });
        if (this.started && !this.pollTimer) {
            this.scheduleNextPoll();
        }
        return true;
    }

    // unwatchCollection removes a collection from snapshot polling once no enabled snapshot-backed jobs need it.
    public unwatchCollection(collectionSlug: string): boolean {
        if (!this.watchedCollectionSlugs.delete(collectionSlug)) {
            return false;
        }

        log.info("collectionUnwatched", "Removed watched collection", {
            collectionSlug,
            watchedCollectionCount: this.watchedCollectionSlugs.size,
        });
        if (this.watchedCollectionSlugs.size === 0 && this.pollTimer) {
            clearTimeout(this.pollTimer);
            this.pollTimer = undefined;
        }
        return true;
    }

    // reconcileWatchedCollections makes snapshot polling match the current enabled DB job set.
    public reconcileWatchedCollections(collectionSlugs: string[]): {
        added: number;
        removed: number;
    } {
        const next = new Set(collectionSlugs);
        let added = 0;
        let removed = 0;

        for (const collectionSlug of Array.from(this.watchedCollectionSlugs)) {
            if (!next.has(collectionSlug) && this.unwatchCollection(collectionSlug)) {
                removed += 1;
            }
        }

        for (const collectionSlug of next) {
            if (this.watchCollection(collectionSlug)) {
                added += 1;
            }
        }

        return { added, removed };
    }

    // requestRefresh schedules a TTL-aware async refresh and never starts duplicate network fetches for fresh snapshots.
    public requestRefresh(
        collectionSlug: string,
        reason: string = "unspecified",
    ): void {
        if (!this.watchedCollectionSlugs.has(collectionSlug)) {
            return;
        }

        void this.refreshAndWait(collectionSlug, reason, {
            respectTtl: true,
        }).catch(() => undefined);
    }

    // refreshAndWait serializes same-collection refreshes and optionally reuses fresh or in-flight snapshots via TTL.
    public async refreshAndWait(
        collectionSlug: string,
        reason: string = "unspecified",
        options: CollectionOfferRefreshOptions = {},
    ): Promise<void> {
        if (!this.watchedCollectionSlugs.has(collectionSlug)) {
            return;
        }

        if (options.respectTtl && this.isSnapshotFresh(collectionSlug)) {
            this.logFreshSnapshotSkip(collectionSlug, reason);
            return;
        }

        if (
            options.respectTtl &&
            (await this.waitForFreshInFlightRefresh(collectionSlug, reason))
        ) {
            return;
        }

        if (options.respectTtl && this.isRefreshBackoffActive(collectionSlug)) {
            this.logRefreshBackoffSkip(collectionSlug, reason);
            return;
        }

        await this.refreshCollection(collectionSlug, reason, options);
    }

    private async waitForFreshInFlightRefresh(
        collectionSlug: string,
        reason: string,
    ): Promise<boolean> {
        const state = this.refreshStates.get(collectionSlug);
        if (!state?.refreshing || !state.inFlightPromise) {
            return false;
        }

        log.debug(
            "waitForFreshInFlightRefresh",
            "Waiting for in-flight collection offer snapshot refresh",
            {
                collectionSlug,
                reason,
                ttlMs: this.refreshTtlMs,
            },
        );
        await state.inFlightPromise;
        if (!this.isSnapshotFresh(collectionSlug)) {
            return false;
        }

        this.logFreshSnapshotSkip(collectionSlug, reason);
        return true;
    }

    private logFreshSnapshotSkip(collectionSlug: string, reason: string): void {
        const snapshotAgeMs = this.getSnapshotAgeMs(collectionSlug);
        const snapshot = this.snapshots.get(collectionSlug);
        log.debug(
            COLLECTION_OFFER_SNAPSHOT_LOG_ACTION.FreshSnapshotSkipped,
            "Skipping fresh collection offer snapshot refresh",
            {
                collectionSlug,
                reason,
                snapshotAgeMs,
                ttlMs: snapshot
                    ? this.getSnapshotFreshnessTtlMs(snapshot)
                    : this.refreshTtlMs,
                baseTtlMs: this.refreshTtlMs,
                maxTtlMs: this.refreshMaxTtlMs,
                durationMultiplier: this.refreshDurationMultiplier,
            },
        );
    }

    private logRefreshBackoffSkip(collectionSlug: string, reason: string): void {
        const state = this.refreshStates.get(collectionSlug);
        log.debug(
            COLLECTION_OFFER_SNAPSHOT_LOG_ACTION.RefreshBackoffSkipped,
            "Skipping collection offer snapshot refresh during failure backoff",
            {
                collectionSlug,
                reason,
                failureCount: state?.failureCount ?? 0,
                lastStartedAt: state?.lastStartedAt ?? null,
                lastError: state?.lastError ?? null,
                nextEligibleRefreshAt: state?.nextEligibleRefreshAt ?? null,
                backoffRemainingMs: state?.nextEligibleRefreshAt
                    ? Math.max(0, state.nextEligibleRefreshAt - Date.now())
                    : null,
            },
        );
    }

    private async refreshCollection(
        collectionSlug: string,
        reason: string,
        options: CollectionOfferRefreshOptions,
    ): Promise<void> {
        const state = this.getRefreshState(collectionSlug);
        if (state.refreshing) {
            state.pendingRequest = this.mergePendingRefreshRequest(
                state.pendingRequest,
                {
                    reason,
                    respectTtl: options.respectTtl === true,
                },
            );
            return await (state.inFlightPromise ?? Promise.resolve());
        }

        state.refreshing = true;
        let nextReason = reason;
        state.inFlightPromise = (async () => {
            try {
                while (true) {
                    log.debug(
                        COLLECTION_OFFER_SNAPSHOT_LOG_ACTION.SnapshotRefreshStarted,
                        "Refreshing collection offer snapshot",
                        {
                            collectionSlug,
                            reason: nextReason,
                        },
                    );
                    state.lastStartedAt = Date.now();
                    let sourceResult: CollectionOfferSourceResult;
                    try {
                        sourceResult =
                            await this.source.getAllOffers(collectionSlug);
                    } catch (error: unknown) {
                        this.recordRefreshFailure(
                            state,
                            collectionSlug,
                            nextReason,
                            error,
                        );
                        throw error;
                    }
                    this.recordRefreshSuccess(state);
                    this.logSnapshotSummary(
                        collectionSlug,
                        sourceResult,
                        nextReason,
                    );
                    this.snapshots.set(collectionSlug, {
                        collectionSlug,
                        offers: sourceResult.offers,
                        refreshedAt: Date.now(),
                        metrics: sourceResult.metrics,
                    });
                    const snapshot = this.snapshots.get(collectionSlug);
                    if (snapshot) {
                        // Notify read-model observers after the authoritative snapshot has been replaced.
                        this.observer?.onSnapshotRefreshed(snapshot, nextReason);
                    }

                    const pendingRequest = state.pendingRequest;
                    if (!pendingRequest) {
                        return;
                    }

                    state.pendingRequest = undefined;
                    if (
                        pendingRequest.respectTtl &&
                        this.isSnapshotFresh(collectionSlug)
                    ) {
                        this.logFreshSnapshotSkip(
                            collectionSlug,
                            pendingRequest.reason,
                        );
                        return;
                    }

                    nextReason = pendingRequest.reason;
                }
            } finally {
                state.refreshing = false;
                state.pendingRequest = undefined;
                state.inFlightPromise = undefined;
            }
        })();

        return await state.inFlightPromise;
    }

    private getRefreshState(collectionSlug: string): CollectionRefreshState {
        let state = this.refreshStates.get(collectionSlug);
        if (!state) {
            state = { refreshing: false, failureCount: 0 };
            this.refreshStates.set(collectionSlug, state);
        }

        return state;
    }

    private scheduleNextPoll(): void {
        if (!this.started || this.watchedCollectionSlugs.size === 0) {
            this.pollTimer = undefined;
            return;
        }

        this.pollTimer = setTimeout(() => {
            this.pollTimer = undefined;
            if (!this.started) {
                return;
            }

            this.watchedCollectionSlugs.forEach((collectionSlug) =>
                this.requestRefresh(collectionSlug, "poll cadence"),
            );
            this.scheduleNextPoll();
        }, this.pollIntervalMs);
    }

    private mergeRefreshReasons(
        existing: string | undefined,
        incoming: string,
    ): string {
        if (!existing) {
            return incoming;
        }

        const seen = new Set(existing.split(" || "));
        if (seen.has(incoming)) {
            return existing;
        }

        return `${existing} || ${incoming}`;
    }

    private mergePendingRefreshRequest(
        existing: PendingRefreshRequest | undefined,
        incoming: PendingRefreshRequest,
    ): PendingRefreshRequest {
        if (!existing) {
            return incoming;
        }

        return {
            reason: this.mergeRefreshReasons(existing.reason, incoming.reason),
            respectTtl: existing.respectTtl && incoming.respectTtl,
        };
    }

    private isSnapshotFresh(collectionSlug: string): boolean {
        if (this.refreshTtlMs <= 0) {
            return false;
        }

        const snapshot = this.snapshots.get(collectionSlug);
        if (!snapshot) {
            return false;
        }

        return (
            Date.now() - snapshot.refreshedAt <
            this.getSnapshotFreshnessTtlMs(snapshot)
        );
    }

    private isRefreshBackoffActive(collectionSlug: string): boolean {
        const nextEligibleRefreshAt =
            this.refreshStates.get(collectionSlug)?.nextEligibleRefreshAt;
        return (
            nextEligibleRefreshAt !== undefined &&
            Date.now() < nextEligibleRefreshAt
        );
    }

    private getSnapshotAgeMs(collectionSlug: string): number | null {
        const snapshot = this.snapshots.get(collectionSlug);
        if (!snapshot) {
            return null;
        }

        return Date.now() - snapshot.refreshedAt;
    }

    private getSnapshotFreshnessTtlMs(
        snapshot: CollectionOfferSnapshot,
    ): number {
        const adaptiveTtlMs = Math.ceil(
            snapshot.metrics.durationMs * this.refreshDurationMultiplier,
        );
        return Math.min(
            this.refreshMaxTtlMs,
            Math.max(this.refreshTtlMs, adaptiveTtlMs),
        );
    }

    private recordRefreshSuccess(state: CollectionRefreshState): void {
        state.failureCount = 0;
        state.lastError = undefined;
        state.nextEligibleRefreshAt = undefined;
    }

    private recordRefreshFailure(
        state: CollectionRefreshState,
        collectionSlug: string,
        reason: string,
        error: unknown,
    ): void {
        state.failureCount += 1;
        state.lastError =
            error instanceof Error ? error.message : String(error);
        const exponent = Math.min(
            state.failureCount - 1,
            COLLECTION_OFFER_SNAPSHOT_FAILURE_BACKOFF_MAX_EXPONENT,
        );
        const rawBackoffMs =
            this.refreshTtlMs *
            COLLECTION_OFFER_SNAPSHOT_FAILURE_BACKOFF_MULTIPLIER ** exponent;
        const jitterMs = Math.floor(
            rawBackoffMs *
                COLLECTION_OFFER_SNAPSHOT_FAILURE_BACKOFF_JITTER_RATIO *
                Math.random(),
        );
        const backoffMs = Math.min(
            this.refreshMaxTtlMs,
            rawBackoffMs + jitterMs,
        );
        state.nextEligibleRefreshAt = Date.now() + backoffMs;
        log.warn(
            COLLECTION_OFFER_SNAPSHOT_LOG_ACTION.RefreshFailed,
            "Collection offer snapshot refresh failed",
            {
                collectionSlug,
                reason,
                failureCount: state.failureCount,
                backoffMs,
                nextEligibleRefreshAt: state.nextEligibleRefreshAt,
                ...toErrorLogFields(error),
            },
        );
    }

    private logSnapshotSummary(
        collectionSlug: string,
        sourceResult: CollectionOfferSourceResult,
        reason: string,
    ): void {
        type SnapshotCriteria = {
            traits?: Array<{ type?: string; trait_type?: string }>;
            trait?: { type?: string; trait_type?: string };
            encoded_token_ids?: string;
            encodedTokenIds?: string;
        };

        let collectionWideLike = 0;
        let criteriaOffers = 0;
        let multiTraitOffers = 0;
        let explicitItemOffers = 0;
        const seenTraitTypes = new Set<string>();
        const offers = sourceResult.offers;

        for (const rawOffer of offers) {
            const parsedOffer = rawOffer as {
                criteria?: SnapshotCriteria;
                protocolData?: {
                    criteria?: SnapshotCriteria;
                    parameters?: {
                        consideration?: Array<{ itemType?: number | string }>;
                        offer?: Array<{ itemType?: number | string }>;
                    };
                };
                protocol_data?: {
                    criteria?: SnapshotCriteria;
                    parameters?: {
                        consideration?: Array<{ itemType?: number | string }>;
                        offer?: Array<{ itemType?: number | string }>;
                    };
                };
            };

            const criteria =
                parsedOffer.criteria ??
                parsedOffer.protocolData?.criteria ??
                parsedOffer.protocol_data?.criteria;
            const traitCriteria = criteria?.traits ?? (criteria?.trait ? [criteria.trait] : []);

            if (Array.isArray(traitCriteria) && traitCriteria.length > 0) {
                criteriaOffers++;
                if (traitCriteria.length > 1) {
                    multiTraitOffers++;
                }
                traitCriteria.forEach((entry) => {
                    const type = entry.type ?? entry.trait_type;
                    if (typeof type === "string") {
                        seenTraitTypes.add(type);
                    }
                });
                continue;
            }

            const encodedIds =
                criteria?.encoded_token_ids ?? criteria?.encodedTokenIds;
            if (typeof encodedIds === "string" && encodedIds === "*") {
                collectionWideLike++;
                continue;
            }

            const nftItems = [
                ...(Array.isArray(parsedOffer.protocolData?.parameters?.consideration)
                    ? parsedOffer.protocolData.parameters.consideration
                    : []),
                ...(Array.isArray(parsedOffer.protocolData?.parameters?.offer)
                    ? parsedOffer.protocolData.parameters.offer
                    : []),
                ...(Array.isArray(parsedOffer.protocol_data?.parameters?.consideration)
                    ? parsedOffer.protocol_data.parameters.consideration
                    : []),
                ...(Array.isArray(parsedOffer.protocol_data?.parameters?.offer)
                    ? parsedOffer.protocol_data.parameters.offer
                    : []),
            ].filter((item) => [2, 3].includes(Number(item.itemType)));

            if (nftItems.length > 0) {
                explicitItemOffers++;
            }
        }

        log.debug("snapshotRefreshed", "Collection offer snapshot refreshed", {
            collectionSlug,
            reason,
            offerCount: offers.length,
            pageCount: sourceResult.metrics.pageCount,
            durationMs: sourceResult.metrics.durationMs,
            firstPriceWei: sourceResult.metrics.firstPriceWei,
            lastPriceWei: sourceResult.metrics.lastPriceWei,
            minPriceWei: sourceResult.metrics.minPriceWei,
            maxPriceWei: sourceResult.metrics.maxPriceWei,
            finalCursor: sourceResult.metrics.finalCursor,
            adaptiveTtlMs: this.getSnapshotFreshnessTtlMs({
                collectionSlug,
                offers,
                refreshedAt: Date.now(),
                metrics: sourceResult.metrics,
            }),
            collectionWideOfferCount: collectionWideLike,
            criteriaOfferCount: criteriaOffers,
            multiTraitOfferCount: multiTraitOffers,
            explicitItemOfferCount: explicitItemOffers,
            traitTypes: Array.from(seenTraitTypes).sort(),
        });
    }
}
