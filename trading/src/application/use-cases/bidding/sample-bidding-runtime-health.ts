import type {
    BiddingCommandQueueHealth,
    BiddingCommandQueueHealthPort,
} from "./bidding-command-queue-health.js";
import type { CollectionOfferFreshnessHealth } from "./collection-offer-snapshot-service.js";
import type { BiddingPublicationHealth } from "./bidding-bid-book-projection.js";
import type { BidderPositionHealth } from "./bidder.js";
import { observeBestEffort } from "../../../utils/observe-best-effort.js";
import {
    BIDDING_LOG_COMPONENT,
    createBiddingComponentLogger,
    toErrorLogFields,
} from "../../../utils/bidding-log.js";

export const BIDDING_HEALTH_COMPONENT = {
    CommandQueue: "command_queue",
    Snapshots: "snapshots",
    Publication: "publication",
    Positions: "positions",
} as const;
export type BiddingHealthComponent =
    (typeof BIDDING_HEALTH_COMPONENT)[keyof typeof BIDDING_HEALTH_COMPONENT];

export interface BiddingRuntimeHealthObserver {
    onCommandQueueHealth(health: BiddingCommandQueueHealth): void;
    onSnapshotFreshness(health: CollectionOfferFreshnessHealth): void;
    onPublicationHealth(health: BiddingPublicationHealth): void;
    onPositionHealth(health: BidderPositionHealth): void;
    onHealthSample(input: {
        component: BiddingHealthComponent;
        succeeded: boolean;
        sampledAtMs: number;
    }): void;
}

const log = createBiddingComponentLogger(BIDDING_LOG_COMPONENT.BiddingRuntime);
const HEALTH_SAMPLE_LOG_ACTION = "healthSampleFailed";

// Health sampling is independent of command execution, so a held strategy cannot hide queue growth.
export class SampleBiddingRuntimeHealth {
    constructor(
        private readonly commands: BiddingCommandQueueHealthPort,
        private readonly snapshots: {
            readFreshness(nowMs: number): CollectionOfferFreshnessHealth;
        },
        private readonly publication: {
            readPublicationHealth(): BiddingPublicationHealth;
        },
        private readonly positions: {
            readPositionHealth(): BidderPositionHealth;
        },
        private readonly observer: BiddingRuntimeHealthObserver,
        private readonly claimTimeoutMs: number,
    ) {}

    async sample(): Promise<void> {
        await Promise.all([
            this.read(
                BIDDING_HEALTH_COMPONENT.CommandQueue,
                () => this.commands.readQueueHealth(this.claimTimeoutMs),
                (value) => this.observer.onCommandQueueHealth(value),
            ),
            this.read(
                BIDDING_HEALTH_COMPONENT.Snapshots,
                () => this.snapshots.readFreshness(Date.now()),
                (value) => this.observer.onSnapshotFreshness(value),
            ),
            this.read(
                BIDDING_HEALTH_COMPONENT.Publication,
                () => this.publication.readPublicationHealth(),
                (value) => this.observer.onPublicationHealth(value),
            ),
            this.read(
                BIDDING_HEALTH_COMPONENT.Positions,
                () => this.positions.readPositionHealth(),
                (value) => this.observer.onPositionHealth(value),
            ),
        ]);
    }

    private async read<T>(
        component: BiddingHealthComponent,
        read: () => T | Promise<T>,
        report: (value: T) => void,
    ): Promise<void> {
        let succeeded = false;
        try {
            const value = await read();
            observeBestEffort(() => report(value));
            succeeded = true;
        } catch (error: unknown) {
            log.warn(
                HEALTH_SAMPLE_LOG_ACTION,
                "Bidding health sample failed; the next scheduled sample will retry",
                { componentKind: component, ...toErrorLogFields(error) },
            );
        } finally {
            observeBestEffort(() =>
                this.observer.onHealthSample({
                    component,
                    succeeded,
                    sampledAtMs: Date.now(),
                }),
            );
        }
    }
}
