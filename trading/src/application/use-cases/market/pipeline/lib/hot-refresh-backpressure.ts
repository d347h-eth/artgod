import { MarketEvent, Scope } from "../../../../../domain/market/event.js";
import {
    BIDDING_LOG_COMPONENT,
    createBiddingComponentLogger,
    toErrorLogFields,
} from "../../../../../utils/bidding-log.js";
import {
    EventCallback,
    EventCallbackBuilder,
    WrappingFn,
} from "../pipeline.js";

// Stable stage names used when wiring the bidding hot-refresh pipeline.
export const HOT_REFRESH_BACKPRESSURE_STAGE_NAME = {
    BroadEvents: "broad-hot-refresh-backpressure",
} as const;

export interface HotRefreshBackpressureOptions {
    broadCooldownMs: number;
}

interface BroadRefreshLane {
    running: boolean;
    pendingEvents: Map<string, MarketEvent>;
    pendingSignalCount: number;
    nextRunAt: number;
    timer?: ReturnType<typeof setTimeout>;
}

const HOT_REFRESH_BACKPRESSURE_LOG_ACTION = {
    BroadEventQueued: "broadEventQueued",
    BroadPassStarted: "broadPassStarted",
    BroadPassFailed: "broadPassFailed",
} as const;

const BROAD_EVENT_SIGNATURE_PREFIX = {
    Collection: "collection",
    Trait: "trait",
} as const;

const log = createBiddingComponentLogger(
    BIDDING_LOG_COMPONENT.HotRefreshBackpressure,
);

// HotRefreshBackpressure makes broad stream wake-ups cheap while preserving exact-token immediacy.
export class HotRefreshBackpressure implements EventCallbackBuilder {
    private readonly lanes = new Map<string, BroadRefreshLane>();
    private readonly broadCooldownMs: number;

    constructor(
        private readonly name: string,
        options: HotRefreshBackpressureOptions,
    ) {
        if (
            !Number.isFinite(options.broadCooldownMs) ||
            options.broadCooldownMs < 0
        ) {
            throw new Error(
                `[HotRefreshBackpressure] broadCooldownMs must be >= 0. received=${options.broadCooldownMs}`,
            );
        }

        this.broadCooldownMs = options.broadCooldownMs;
    }

    public getName(): string {
        return this.name;
    }

    public getWrappingFn(): WrappingFn {
        return (callback: EventCallback): EventCallback => {
            return async (marketEvent: MarketEvent) => {
                if (!isBroadHotRefreshEvent(marketEvent)) {
                    await callback(marketEvent);
                    return;
                }

                this.queueBroadEvent(marketEvent, callback);
            };
        };
    }

    private queueBroadEvent(
        marketEvent: MarketEvent,
        callback: EventCallback,
    ): void {
        const collectionSlug = marketEvent.getCollectionSlug();
        const lane = this.getLane(collectionSlug);
        const signature = createBroadEventSignature(marketEvent);
        lane.pendingEvents.set(signature, marketEvent);
        lane.pendingSignalCount += 1;

        if (lane.running || lane.timer) {
            log.debug(
                HOT_REFRESH_BACKPRESSURE_LOG_ACTION.BroadEventQueued,
                "Queued broad bidding hot-refresh signal",
                {
                    collectionSlug,
                    eventType: marketEvent.getType(),
                    eventScope: marketEvent.getScope(),
                    signature,
                    pendingEventCount: lane.pendingEvents.size,
                    pendingSignalCount: lane.pendingSignalCount,
                    running: lane.running,
                    delayed: lane.timer !== undefined,
                },
            );
            return;
        }

        const delayMs = Math.max(0, lane.nextRunAt - Date.now());
        if (delayMs > 0) {
            this.scheduleLane(collectionSlug, lane, callback, delayMs);
            log.debug(
                HOT_REFRESH_BACKPRESSURE_LOG_ACTION.BroadEventQueued,
                "Queued broad bidding hot-refresh signal until cooldown expires",
                {
                    collectionSlug,
                    eventType: marketEvent.getType(),
                    eventScope: marketEvent.getScope(),
                    signature,
                    delayMs,
                    pendingEventCount: lane.pendingEvents.size,
                    pendingSignalCount: lane.pendingSignalCount,
                },
            );
            return;
        }

        this.startLane(collectionSlug, lane, callback);
    }

    private scheduleLane(
        collectionSlug: string,
        lane: BroadRefreshLane,
        callback: EventCallback,
        delayMs: number,
    ): void {
        lane.timer = setTimeout(() => {
            lane.timer = undefined;
            if (!lane.running) {
                this.startLane(collectionSlug, lane, callback);
            }
        }, delayMs);
    }

    private startLane(
        collectionSlug: string,
        lane: BroadRefreshLane,
        callback: EventCallback,
    ): void {
        if (lane.pendingEvents.size === 0) {
            return;
        }

        const events = Array.from(lane.pendingEvents.values());
        const pendingSignalCount = lane.pendingSignalCount;
        lane.pendingEvents.clear();
        lane.pendingSignalCount = 0;
        lane.running = true;

        log.debug(
            HOT_REFRESH_BACKPRESSURE_LOG_ACTION.BroadPassStarted,
            "Started coalesced broad bidding hot-refresh pass",
            {
                collectionSlug,
                eventCount: events.length,
                signalCount: pendingSignalCount,
                cooldownMs: this.broadCooldownMs,
            },
        );

        void (async () => {
            try {
                for (const event of events) {
                    await callback(event);
                }
            } catch (error: unknown) {
                log.error(
                    HOT_REFRESH_BACKPRESSURE_LOG_ACTION.BroadPassFailed,
                    "Coalesced broad bidding hot-refresh pass failed",
                    {
                        collectionSlug,
                        ...toErrorLogFields(error),
                    },
                );
            } finally {
                lane.running = false;
                lane.nextRunAt = Date.now() + this.broadCooldownMs;
                if (lane.pendingEvents.size > 0) {
                    this.scheduleLane(
                        collectionSlug,
                        lane,
                        callback,
                        this.broadCooldownMs,
                    );
                }
            }
        })();
    }

    private getLane(collectionSlug: string): BroadRefreshLane {
        let lane = this.lanes.get(collectionSlug);
        if (!lane) {
            lane = {
                running: false,
                pendingEvents: new Map(),
                pendingSignalCount: 0,
                nextRunAt: 0,
            };
            this.lanes.set(collectionSlug, lane);
        }

        return lane;
    }
}

function isBroadHotRefreshEvent(marketEvent: MarketEvent): boolean {
    return (
        marketEvent.getScope() === Scope.Collection ||
        marketEvent.getScope() === Scope.Trait
    );
}

function createBroadEventSignature(marketEvent: MarketEvent): string {
    if (marketEvent.getScope() === Scope.Trait) {
        return `${BROAD_EVENT_SIGNATURE_PREFIX.Trait}:${formatTraitCriteriaSignature(marketEvent)}`;
    }

    return BROAD_EVENT_SIGNATURE_PREFIX.Collection;
}

function formatTraitCriteriaSignature(marketEvent: MarketEvent): string {
    const criteria = marketEvent
        .getTraitCriteria()
        .map((criterion) => `${criterion.type}=${criterion.value}`)
        .sort();

    return criteria.join("|");
}
