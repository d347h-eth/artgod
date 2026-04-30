import type { CollectionOfferSnapshot } from "./collection-offer-snapshot-service.js";
import { biddingLog } from "../../../utils/bidding-log.js";

export interface BiddingBidBookProjectionResult {
    collectionSlug: string;
    rowCount: number;
    durationMs: number;
}

export interface BiddingBidBookProjectionPort {
    replaceCollectionBidBook(
        snapshot: CollectionOfferSnapshot,
        reason: string,
    ): Promise<BiddingBidBookProjectionResult>;
}

type ProjectionState = {
    running: boolean;
    latestSnapshot?: CollectionOfferSnapshot;
    pendingReason?: string;
    timer?: ReturnType<typeof setTimeout>;
    lastCompletedAt: number;
};

// Coalesces snapshot-to-bid-book projection work without blocking snapshot refresh or bidder decisions.
export class BiddingBidBookProjectionScheduler {
    private readonly states = new Map<string, ProjectionState>();
    private stopped = false;

    constructor(
        private readonly projectionPort: BiddingBidBookProjectionPort,
        private readonly throttleMs: number,
    ) {}

    // requestProjection keeps only the latest snapshot per collection and throttles replacement writes.
    public requestProjection(
        snapshot: CollectionOfferSnapshot,
        reason: string,
    ): void {
        if (this.stopped) {
            return;
        }

        const state = this.getState(snapshot.collectionSlug);
        state.latestSnapshot = snapshot;
        state.pendingReason = mergeReasons(state.pendingReason, reason);

        if (state.running || state.timer) {
            return;
        }

        this.schedule(snapshot.collectionSlug, state);
    }

    // stop cancels delayed projection work during runtime shutdown.
    public stop(): void {
        this.stopped = true;
        for (const state of this.states.values()) {
            if (state.timer) {
                clearTimeout(state.timer);
                state.timer = undefined;
            }
        }
    }

    private getState(collectionSlug: string): ProjectionState {
        let state = this.states.get(collectionSlug);
        if (!state) {
            state = {
                running: false,
                lastCompletedAt: 0,
            };
            this.states.set(collectionSlug, state);
        }
        return state;
    }

    private schedule(collectionSlug: string, state: ProjectionState): void {
        const elapsedSinceLastRun = Date.now() - state.lastCompletedAt;
        const delayMs =
            state.lastCompletedAt === 0
                ? 0
                : Math.max(0, this.throttleMs - elapsedSinceLastRun);

        state.timer = setTimeout(() => {
            state.timer = undefined;
            void this.run(collectionSlug, state);
        }, delayMs);
    }

    private async run(
        collectionSlug: string,
        state: ProjectionState,
    ): Promise<void> {
        if (this.stopped || state.running || !state.latestSnapshot) {
            return;
        }

        const snapshot = state.latestSnapshot;
        const reason = state.pendingReason ?? "unspecified";
        state.latestSnapshot = undefined;
        state.pendingReason = undefined;
        state.running = true;

        try {
            // Persist the latest snapshot into the local bid-book read model for UI reads.
            const result = await this.projectionPort.replaceCollectionBidBook(
                snapshot,
                reason,
            );
            state.lastCompletedAt = Date.now();
            biddingLog.debug(
                `[BiddingBidBookProjectionScheduler] Projection complete for ${result.collectionSlug}. rows=${result.rowCount}, durationMs=${result.durationMs}, reason=${reason}`,
            );
        } catch (error: unknown) {
            const message = error instanceof Error ? error.message : String(error);
            state.lastCompletedAt = Date.now();
            biddingLog.error(
                `[BiddingBidBookProjectionScheduler] Projection failed for ${collectionSlug}. reason=${reason}, error=${message}`,
            );
        } finally {
            state.running = false;
        }

        if (!this.stopped && state.latestSnapshot && !state.timer) {
            this.schedule(collectionSlug, state);
        }
    }
}

function mergeReasons(existing: string | undefined, incoming: string): string {
    if (!existing) {
        return incoming;
    }

    const seen = new Set(existing.split(" || "));
    if (seen.has(incoming)) {
        return existing;
    }

    return `${existing} || ${incoming}`;
}
