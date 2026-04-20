import { biddingLog } from "../../../utils/bidding-log.js";
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

interface CollectionRefreshState {
    refreshing: boolean;
    pendingReason?: string;
    inFlightPromise?: Promise<void>;
}

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
    ) {
        this.watchedCollectionSlugs = new Set(collectionSlugs);
    }

    public start(): void {
        if (this.started || this.watchedCollectionSlugs.size === 0) {
            return;
        }

        this.started = true;
        this.scheduleNextPoll();
    }

    // stop cancels the recurring poll timer so the runtime can shut down cleanly.
    public stop(): void {
        this.started = false;
        if (this.pollTimer) {
            clearTimeout(this.pollTimer);
            this.pollTimer = undefined;
        }
    }

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

    public getSnapshot(collectionSlug: string): CollectionOfferSnapshot | null {
        return this.snapshots.get(collectionSlug) ?? null;
    }

    public requestRefresh(
        collectionSlug: string,
        reason: string = "unspecified",
    ): void {
        if (!this.watchedCollectionSlugs.has(collectionSlug)) {
            return;
        }

        void this.refreshAndWait(collectionSlug, reason).catch((error: unknown) => {
            const message =
                error instanceof Error ? error.message : String(error);
            biddingLog.error(
                `[CollectionOfferSnapshotService] Failed to refresh ${collectionSlug} (reason=${reason}): ${message}`,
            );
        });
    }

    public async refreshAndWait(
        collectionSlug: string,
        reason: string = "unspecified",
        options: CollectionOfferRefreshOptions = {},
    ): Promise<void> {
        if (!this.watchedCollectionSlugs.has(collectionSlug)) {
            return;
        }

        if (options.respectTtl && this.isSnapshotFresh(collectionSlug)) {
            const snapshotAgeMs = this.getSnapshotAgeMs(collectionSlug);
            biddingLog.debug(
                `[CollectionOfferSnapshotService] Skipping ${collectionSlug} refresh: reason=${reason}, snapshotAgeMs=${snapshotAgeMs}, ttlMs=${this.refreshTtlMs}`,
            );
            return;
        }

        await this.refreshCollection(collectionSlug, reason);
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
        this.pollTimer = setTimeout(() => {
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
            ].filter((item) => [2, 3].includes(Number(item.itemType)));

            if (nftItems.length > 0) {
                explicitItemOffers++;
            }
        }

        biddingLog.debug(
            `[CollectionOfferSnapshotService] Refreshed ${collectionSlug}: reason=${reason}, total=${offers.length}, collectionWide=${collectionWideLike}, criteria=${criteriaOffers}, multiTrait=${multiTraitOffers}, explicitItem=${explicitItemOffers}, traitTypes=${Array.from(seenTraitTypes).sort().join("|") || "none"}`,
        );
    }
}
