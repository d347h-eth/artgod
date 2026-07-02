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
    StreamEvents: "hot-refresh-backpressure",
} as const;

export interface HotRefreshBackpressureOptions {
    broadCooldownMs: number;
    itemCooldownMs: number;
}

type HotRefreshLaneKind = "broad" | "item";

interface HotRefreshLane {
    running: boolean;
    pendingEvents: Map<string, MarketEvent>;
    pendingSignalCount: number;
    nextRunAt: number;
    timer?: ReturnType<typeof setTimeout>;
    kind: HotRefreshLaneKind;
}

const HOT_REFRESH_BACKPRESSURE_LOG_ACTION = {
    BroadEventQueued: "broadEventQueued",
    BroadPassStarted: "broadPassStarted",
    BroadPassFailed: "broadPassFailed",
    ItemEventQueued: "itemEventQueued",
    ItemPassStarted: "itemPassStarted",
    ItemPassFailed: "itemPassFailed",
} as const;

const BROAD_EVENT_SIGNATURE_PREFIX = {
    Collection: "collection",
    Trait: "trait",
} as const;

const ITEM_EVENT_SIGNATURE_PREFIX = "item";

const log = createBiddingComponentLogger(
    BIDDING_LOG_COMPONENT.HotRefreshBackpressure,
);

// HotRefreshBackpressure makes stream wake-ups cheap while preserving the highest price signal per scope.
export class HotRefreshBackpressure implements EventCallbackBuilder {
    private readonly lanes = new Map<string, HotRefreshLane>();
    private readonly broadCooldownMs: number;
    private readonly itemCooldownMs: number;
    private stopped = false;

    constructor(
        private readonly name: string,
        options: HotRefreshBackpressureOptions,
    ) {
        if (
            !Number.isFinite(options.broadCooldownMs) ||
            options.broadCooldownMs <= 0
        ) {
            throw new Error(
                `[HotRefreshBackpressure] broadCooldownMs must be > 0. received=${options.broadCooldownMs}`,
            );
        }
        if (
            !Number.isFinite(options.itemCooldownMs) ||
            options.itemCooldownMs <= 0
        ) {
            throw new Error(
                `[HotRefreshBackpressure] itemCooldownMs must be > 0. received=${options.itemCooldownMs}`,
            );
        }

        this.broadCooldownMs = options.broadCooldownMs;
        this.itemCooldownMs = options.itemCooldownMs;
    }

    public getName(): string {
        return this.name;
    }

    // stop prevents late stream events or queued hot-refresh passes from outliving the runtime.
    public stop(): void {
        this.stopped = true;
        for (const lane of this.lanes.values()) {
            if (lane.timer) {
                clearTimeout(lane.timer);
            }
            lane.timer = undefined;
            lane.pendingEvents.clear();
            lane.pendingSignalCount = 0;
        }
        this.lanes.clear();
    }

    public getWrappingFn(): WrappingFn {
        return (callback: EventCallback): EventCallback => {
            return async (marketEvent: MarketEvent) => {
                if (this.stopped) {
                    return;
                }

                if (!isSupportedHotRefreshEvent(marketEvent)) {
                    await callback(marketEvent);
                    return;
                }

                this.queueEvent(marketEvent, callback);
            };
        };
    }

    private queueEvent(
        marketEvent: MarketEvent,
        callback: EventCallback,
    ): void {
        if (this.stopped) {
            return;
        }

        const laneKey = createLaneKey(marketEvent);
        const lane = this.getLane(marketEvent);
        const signature = createEventSignature(marketEvent);
        lane.pendingEvents.set(
            signature,
            selectConservativeEvent(
                lane.pendingEvents.get(signature),
                marketEvent,
            ),
        );
        lane.pendingSignalCount += 1;

        if (lane.running || lane.timer) {
            log.debug(
                this.getQueuedLogAction(lane.kind),
                "Queued bidding hot-refresh signal",
                {
                    collectionSlug: marketEvent.getCollectionSlug(),
                    eventType: marketEvent.getType(),
                    eventScope: marketEvent.getScope(),
                    signature,
                    laneKey,
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
            this.scheduleLane(laneKey, lane, callback, delayMs);
            log.debug(
                this.getQueuedLogAction(lane.kind),
                "Queued bidding hot-refresh signal until cooldown expires",
                {
                    collectionSlug: marketEvent.getCollectionSlug(),
                    eventType: marketEvent.getType(),
                    eventScope: marketEvent.getScope(),
                    signature,
                    laneKey,
                    delayMs,
                    pendingEventCount: lane.pendingEvents.size,
                    pendingSignalCount: lane.pendingSignalCount,
                },
            );
            return;
        }

        this.startLane(laneKey, lane, callback);
    }

    private scheduleLane(
        laneKey: string,
        lane: HotRefreshLane,
        callback: EventCallback,
        delayMs: number,
    ): void {
        lane.timer = setTimeout(() => {
            lane.timer = undefined;
            if (this.stopped) {
                return;
            }
            if (!lane.running) {
                this.startLane(laneKey, lane, callback);
            }
        }, delayMs);
    }

    private startLane(
        laneKey: string,
        lane: HotRefreshLane,
        callback: EventCallback,
    ): void {
        if (this.stopped) {
            return;
        }

        if (lane.pendingEvents.size === 0) {
            return;
        }

        const events = Array.from(lane.pendingEvents.values());
        const pendingSignalCount = lane.pendingSignalCount;
        lane.pendingEvents.clear();
        lane.pendingSignalCount = 0;
        lane.running = true;

        log.debug(
            this.getStartedLogAction(lane.kind),
            "Started coalesced bidding hot-refresh pass",
            {
                laneKey,
                eventCount: events.length,
                signalCount: pendingSignalCount,
                cooldownMs: this.getCooldownMs(lane.kind),
            },
        );

        void (async () => {
            try {
                for (const event of events) {
                    if (this.stopped) {
                        return;
                    }
                    await callback(event);
                }
            } catch (error: unknown) {
                log.error(
                    this.getFailedLogAction(lane.kind),
                    "Coalesced bidding hot-refresh pass failed",
                    {
                        laneKey,
                        ...toErrorLogFields(error),
                    },
                );
            } finally {
                lane.running = false;
                if (this.stopped) {
                    lane.pendingEvents.clear();
                    lane.pendingSignalCount = 0;
                    lane.timer = undefined;
                    return;
                }

                lane.nextRunAt = Date.now() + this.getCooldownMs(lane.kind);
                if (lane.pendingEvents.size > 0) {
                    this.scheduleLane(
                        laneKey,
                        lane,
                        callback,
                        this.getCooldownMs(lane.kind),
                    );
                }
            }
        })();
    }

    private getLane(marketEvent: MarketEvent): HotRefreshLane {
        const laneKey = createLaneKey(marketEvent);
        let lane = this.lanes.get(laneKey);
        if (!lane) {
            lane = {
                running: false,
                pendingEvents: new Map(),
                pendingSignalCount: 0,
                nextRunAt: 0,
                kind: isBroadHotRefreshEvent(marketEvent) ? "broad" : "item",
            };
            this.lanes.set(laneKey, lane);
        }

        return lane;
    }

    private getCooldownMs(kind: HotRefreshLaneKind): number {
        return kind === "broad" ? this.broadCooldownMs : this.itemCooldownMs;
    }

    private getQueuedLogAction(kind: HotRefreshLaneKind): string {
        return kind === "broad"
            ? HOT_REFRESH_BACKPRESSURE_LOG_ACTION.BroadEventQueued
            : HOT_REFRESH_BACKPRESSURE_LOG_ACTION.ItemEventQueued;
    }

    private getStartedLogAction(kind: HotRefreshLaneKind): string {
        return kind === "broad"
            ? HOT_REFRESH_BACKPRESSURE_LOG_ACTION.BroadPassStarted
            : HOT_REFRESH_BACKPRESSURE_LOG_ACTION.ItemPassStarted;
    }

    private getFailedLogAction(kind: HotRefreshLaneKind): string {
        return kind === "broad"
            ? HOT_REFRESH_BACKPRESSURE_LOG_ACTION.BroadPassFailed
            : HOT_REFRESH_BACKPRESSURE_LOG_ACTION.ItemPassFailed;
    }
}

function isSupportedHotRefreshEvent(marketEvent: MarketEvent): boolean {
    return (
        isBroadHotRefreshEvent(marketEvent) ||
        marketEvent.getScope() === Scope.Item
    );
}

function isBroadHotRefreshEvent(marketEvent: MarketEvent): boolean {
    return (
        marketEvent.getScope() === Scope.Collection ||
        marketEvent.getScope() === Scope.Trait
    );
}

function selectConservativeEvent(
    existingEvent: MarketEvent | undefined,
    incomingEvent: MarketEvent,
): MarketEvent {
    if (!existingEvent) {
        return incomingEvent;
    }

    return incomingEvent.getUnitPrice() >= existingEvent.getUnitPrice()
        ? incomingEvent
        : existingEvent;
}

function createLaneKey(marketEvent: MarketEvent): string {
    if (marketEvent.getScope() === Scope.Item) {
        return `${ITEM_EVENT_SIGNATURE_PREFIX}:${marketEvent.getCollectionSlug()}:${marketEvent.getItemID()}`;
    }

    return `${BROAD_EVENT_SIGNATURE_PREFIX.Collection}:${marketEvent.getCollectionSlug()}`;
}

function createEventSignature(marketEvent: MarketEvent): string {
    if (marketEvent.getScope() === Scope.Item) {
        return `${ITEM_EVENT_SIGNATURE_PREFIX}:${marketEvent.getItemID()}`;
    }

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
