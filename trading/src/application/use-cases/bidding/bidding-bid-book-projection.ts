import type { CollectionOfferSnapshot } from "./collection-offer-snapshot-service.js";
import {
    BIDDING_LOG_COMPONENT,
    createBiddingComponentLogger,
    toErrorLogFields,
} from "../../../utils/bidding-log.js";
import { observeBestEffort } from "../../../utils/observe-best-effort.js";

export interface BiddingBidBookProjectionResult {
    collectionSlug: string;
    rowCount: number;
    durationMs: number;
}

// Carries a failed projection attempt into the adapter-owned bid-book state row.
export interface BiddingBidBookProjectionErrorInput {
    snapshot: CollectionOfferSnapshot;
    reason: string;
    errorMessage: string;
    durationMs: number;
}

export interface BiddingBidBookProjectionPort {
    replaceCollectionBidBook(
        snapshot: CollectionOfferSnapshot,
        reason: string,
    ): Promise<BiddingBidBookProjectionResult>;
    recordCollectionBidBookError(
        input: BiddingBidBookProjectionErrorInput,
    ): Promise<void>;
}

// Projection request outcomes expose whether a write started or joined pending work.
export const BIDDING_BID_BOOK_PROJECTION_REQUEST_OUTCOME = {
    Started: "started",
    Coalesced: "coalesced",
} as const;

export type BiddingBidBookProjectionRequestOutcome =
    (typeof BIDDING_BID_BOOK_PROJECTION_REQUEST_OUTCOME)[keyof typeof BIDDING_BID_BOOK_PROJECTION_REQUEST_OUTCOME];

// BiddingBidBookProjectionObservabilityPort reports coalescing, queue latency, and local write cost.
export interface BiddingBidBookProjectionObservabilityPort {
    onProjectionRequested(input: {
        outcome: BiddingBidBookProjectionRequestOutcome;
    }): void;
    onProjectionFinished(input: {
        queueWaitMs: number;
        durationMs: number;
        rowCount: number;
        succeeded: boolean;
    }): void;
    onProjectionStateChanged(input: { active: number; pending: number }): void;
}

type ProjectionState = {
    running: boolean;
    latestSnapshot?: CollectionOfferSnapshot;
    pendingReason?: string;
    timer?: ReturnType<typeof setTimeout>;
    lastCompletedAt: number;
    firstRequestedAt?: number;
};

const log = createBiddingComponentLogger(
    BIDDING_LOG_COMPONENT.BiddingBidBookProjection,
);

// Coalesces snapshot-to-bid-book projection work without blocking snapshot refresh or bidder decisions.
export class BiddingBidBookProjectionScheduler {
    private readonly states = new Map<string, ProjectionState>();
    private readonly activeRuns = new Set<Promise<void>>();
    private activeProjectionCount = 0;
    private pendingProjectionCount = 0;
    private stopped = false;

    constructor(
        private readonly projectionPort: BiddingBidBookProjectionPort,
        private readonly throttleMs: number,
        private readonly observability?: BiddingBidBookProjectionObservabilityPort,
    ) {
        this.reportState();
    }

    // requestProjection keeps only the latest snapshot per collection and throttles replacement writes.
    public requestProjection(
        snapshot: CollectionOfferSnapshot,
        reason: string,
    ): void {
        if (this.stopped) {
            return;
        }

        const state = this.getState(snapshot.collectionSlug);
        const coalesced =
            state.running ||
            state.timer !== undefined ||
            state.latestSnapshot !== undefined;
        if (!state.latestSnapshot) {
            this.pendingProjectionCount += 1;
        }
        state.latestSnapshot = snapshot;
        state.pendingReason = mergeReasons(state.pendingReason, reason);
        state.firstRequestedAt ??= Date.now();
        observeBestEffort(() => {
            this.observability?.onProjectionRequested({
                outcome: coalesced
                    ? BIDDING_BID_BOOK_PROJECTION_REQUEST_OUTCOME.Coalesced
                    : BIDDING_BID_BOOK_PROJECTION_REQUEST_OUTCOME.Started,
            });
        });
        this.reportState();

        if (state.running || state.timer) {
            return;
        }

        this.schedule(snapshot.collectionSlug, state);
    }

    // stop drops delayed work and waits for every active local projection write to settle.
    public async stop(): Promise<void> {
        this.stopped = true;
        for (const state of this.states.values()) {
            if (state.timer) {
                clearTimeout(state.timer);
                state.timer = undefined;
            }
            state.latestSnapshot = undefined;
            state.pendingReason = undefined;
            state.firstRequestedAt = undefined;
        }
        this.pendingProjectionCount = 0;
        this.reportState();
        await Promise.allSettled(Array.from(this.activeRuns));
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
            this.startRun(collectionSlug, state);
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
        const startedAt = Date.now();
        const queueWaitMs = Math.max(
            0,
            startedAt - (state.firstRequestedAt ?? startedAt),
        );
        state.latestSnapshot = undefined;
        this.pendingProjectionCount = Math.max(
            0,
            this.pendingProjectionCount - 1,
        );
        state.pendingReason = undefined;
        state.firstRequestedAt = undefined;
        state.running = true;
        this.activeProjectionCount += 1;
        this.reportState();
        let rowCount = 0;
        let succeeded = false;

        try {
            // Persist the latest snapshot into the local bid-book read model for UI reads.
            const result = await this.projectionPort.replaceCollectionBidBook(
                snapshot,
                reason,
            );
            state.lastCompletedAt = Date.now();
            rowCount = result.rowCount;
            succeeded = true;
            log.debug(
                "projectionComplete",
                "Bidding bid-book projection complete",
                {
                    collectionSlug: result.collectionSlug,
                    rowCount: result.rowCount,
                    durationMs: result.durationMs,
                    reason,
                },
            );
        } catch (error: unknown) {
            state.lastCompletedAt = Date.now();
            const errorMessage = projectionErrorMessage(error);
            try {
                // Persist projection failure state so source selection and UI diagnostics see the error.
                await this.projectionPort.recordCollectionBidBookError({
                    snapshot,
                    reason,
                    errorMessage,
                    durationMs: state.lastCompletedAt - startedAt,
                });
            } catch (recordError: unknown) {
                log.error(
                    "projectionErrorRecordFailed",
                    "Failed to record bidding bid-book projection error",
                    {
                        collectionSlug,
                        reason,
                        ...toErrorLogFields(recordError),
                    },
                );
            }
            log.error(
                "projectionFailed",
                "Bidding bid-book projection failed",
                {
                    collectionSlug,
                    reason,
                    ...toErrorLogFields(error),
                },
            );
        } finally {
            state.running = false;
            this.activeProjectionCount = Math.max(
                0,
                this.activeProjectionCount - 1,
            );
            observeBestEffort(() => {
                this.observability?.onProjectionFinished({
                    queueWaitMs,
                    durationMs: Date.now() - startedAt,
                    rowCount,
                    succeeded,
                });
            });
            this.reportState();
        }

        if (!this.stopped && state.latestSnapshot && !state.timer) {
            this.schedule(collectionSlug, state);
        }
    }

    private startRun(collectionSlug: string, state: ProjectionState): void {
        const run = this.run(collectionSlug, state);
        this.activeRuns.add(run);
        void run.then(
            () => this.activeRuns.delete(run),
            () => this.activeRuns.delete(run),
        );
    }

    private reportState(): void {
        observeBestEffort(() => {
            this.observability?.onProjectionStateChanged({
                active: this.activeProjectionCount,
                pending: this.pendingProjectionCount,
            });
        });
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

function projectionErrorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}
