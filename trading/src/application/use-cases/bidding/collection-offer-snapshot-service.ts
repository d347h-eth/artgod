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
}

export interface CollectionOfferSource {
    getAllOffers(collectionSlug: string): Promise<unknown[]>;
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
    onProgress?: (progress: CollectionOfferBootstrapProgress) => void;
}

export interface CollectionOfferSnapshotObserver {
    onSnapshotRefreshed(snapshot: CollectionOfferSnapshot, reason: string): void;
}

interface CollectionRefreshState {
    refreshing: boolean;
    pendingReason?: string;
    inFlightPromise?: Promise<void>;
}

const log = createBiddingComponentLogger(
    BIDDING_LOG_COMPONENT.CollectionOfferSnapshotService,
);

// Maintains authoritative collection offer snapshots with deduped refreshes per collection.
export class CollectionOfferSnapshotService
    implements CollectionOfferSnapshotProvider, CollectionOfferRefreshPort
{
    private readonly watchedCollectionSlugs: Set<string>;
    private readonly snapshots = new Map<string, CollectionOfferSnapshot>();
    private readonly refreshStates = new Map<string, CollectionRefreshState>();
    private started = false;
    private pollTimer?: ReturnType<typeof setTimeout>;

    constructor(
        private readonly source: CollectionOfferSource,
        collectionSlugs: string[],
        private readonly pollIntervalMs: number,
        private readonly refreshTtlMs: number,
        private readonly observer?: CollectionOfferSnapshotObserver,
    ) {
        this.watchedCollectionSlugs = new Set(collectionSlugs);
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
            Array.from(this.watchedCollectionSlugs).map((collectionSlug) =>
                this.refreshAndWait(collectionSlug, "bootstrap").then(() => {
                    completed += 1;
                    options.onProgress?.({
                        collectionSlug,
                        completed,
                        total,
                    });
                }),
            ),
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
        }).catch((error: unknown) => {
            log.error("refreshFailed", "Collection offer snapshot refresh failed", {
                collectionSlug,
                reason,
                ...toErrorLogFields(error),
            });
        });
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

        await this.refreshCollection(collectionSlug, reason);
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
        log.debug("freshSnapshotSkipped", "Skipping fresh collection offer snapshot refresh", {
            collectionSlug,
            reason,
            snapshotAgeMs,
            ttlMs: this.refreshTtlMs,
        });
    }

    private async refreshCollection(
        collectionSlug: string,
        reason: string,
    ): Promise<void> {
        const state = this.getRefreshState(collectionSlug);
        if (state.refreshing) {
            state.pendingReason = this.mergeRefreshReasons(
                state.pendingReason,
                reason,
            );
            return await (state.inFlightPromise ?? Promise.resolve());
        }

        state.refreshing = true;
        let nextReason = reason;
        state.inFlightPromise = (async () => {
            try {
                while (true) {
                    const offers = await this.source.getAllOffers(collectionSlug);
                    this.logSnapshotSummary(collectionSlug, offers, nextReason);
                    this.snapshots.set(collectionSlug, {
                        collectionSlug,
                        offers,
                        refreshedAt: Date.now(),
                    });
                    const snapshot = this.snapshots.get(collectionSlug);
                    if (snapshot) {
                        // Notify read-model observers after the authoritative snapshot has been replaced.
                        this.observer?.onSnapshotRefreshed(snapshot, nextReason);
                    }

                    if (!state.pendingReason) {
                        return;
                    }

                    nextReason = state.pendingReason;
                    state.pendingReason = undefined;
                }
            } finally {
                state.refreshing = false;
                state.pendingReason = undefined;
                state.inFlightPromise = undefined;
            }
        })();

        return await state.inFlightPromise;
    }

    private getRefreshState(collectionSlug: string): CollectionRefreshState {
        let state = this.refreshStates.get(collectionSlug);
        if (!state) {
            state = { refreshing: false };
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

    private isSnapshotFresh(collectionSlug: string): boolean {
        if (this.refreshTtlMs <= 0) {
            return false;
        }

        const snapshot = this.snapshots.get(collectionSlug);
        if (!snapshot) {
            return false;
        }

        return Date.now() - snapshot.refreshedAt < this.refreshTtlMs;
    }

    private getSnapshotAgeMs(collectionSlug: string): number | null {
        const snapshot = this.snapshots.get(collectionSlug);
        if (!snapshot) {
            return null;
        }

        return Date.now() - snapshot.refreshedAt;
    }

    private logSnapshotSummary(
        collectionSlug: string,
        offers: unknown[],
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
            collectionWideOfferCount: collectionWideLike,
            criteriaOfferCount: criteriaOffers,
            multiTraitOfferCount: multiTraitOffers,
            explicitItemOfferCount: explicitItemOffers,
            traitTypes: Array.from(seenTraitTypes).sort(),
        });
    }
}
