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
    broadMaxPendingSignatures: number;
    itemCooldownMs: number;
    itemMaxPendingSignatures: number;
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

interface PendingEventReference {
    laneKey: string;
    lane: HotRefreshLane;
    signature: string;
    event: MarketEvent;
}

const HOT_REFRESH_BACKPRESSURE_LOG_ACTION = {
    BroadEventQueued: "broadEventQueued",
    BroadPassStarted: "broadPassStarted",
    BroadPassFailed: "broadPassFailed",
    ItemEventQueued: "itemEventQueued",
    ItemPassStarted: "itemPassStarted",
    ItemPassFailed: "itemPassFailed",
    PendingEventDropped: "pendingEventDropped",
    PendingEventEvicted: "pendingEventEvicted",
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
    private readonly broadMaxPendingSignatures: number;
    private readonly itemCooldownMs: number;
    private readonly itemMaxPendingSignatures: number;
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
        if (
            !Number.isInteger(options.broadMaxPendingSignatures) ||
            options.broadMaxPendingSignatures <= 0
        ) {
            throw new Error(
                `[HotRefreshBackpressure] broadMaxPendingSignatures must be an integer > 0. received=${options.broadMaxPendingSignatures}`,
            );
        }
        if (
            !Number.isInteger(options.itemMaxPendingSignatures) ||
            options.itemMaxPendingSignatures <= 0
        ) {
            throw new Error(
                `[HotRefreshBackpressure] itemMaxPendingSignatures must be an integer > 0. received=${options.itemMaxPendingSignatures}`,
            );
        }

        this.broadCooldownMs = options.broadCooldownMs;
        this.broadMaxPendingSignatures = options.broadMaxPendingSignatures;
        this.itemCooldownMs = options.itemCooldownMs;
        this.itemMaxPendingSignatures = options.itemMaxPendingSignatures;
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
        const existingEvent = lane.pendingEvents.get(signature);
        if (
            !existingEvent &&
            !this.reservePendingSignature(lane.kind, laneKey, signature, marketEvent)
        ) {
            return;
        }

        lane.pendingEvents.set(
            signature,
            selectConservativeEvent(existingEvent, marketEvent),
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

    private getMaxPendingSignatures(kind: HotRefreshLaneKind): number {
        return kind === "broad"
            ? this.broadMaxPendingSignatures
            : this.itemMaxPendingSignatures;
    }

    private reservePendingSignature(
        kind: HotRefreshLaneKind,
        laneKey: string,
        signature: string,
        marketEvent: MarketEvent,
    ): boolean {
        const pendingSignatureCount = this.countPendingSignatures(kind);
        const maxPendingSignatures = this.getMaxPendingSignatures(kind);
        if (pendingSignatureCount < maxPendingSignatures) {
            return true;
        }

        const weakestPendingEvent = this.findWeakestPendingEvent(kind);
        if (
            !weakestPendingEvent ||
            marketEvent.getUnitPrice() <= weakestPendingEvent.event.getUnitPrice()
        ) {
            log.debug(
                HOT_REFRESH_BACKPRESSURE_LOG_ACTION.PendingEventDropped,
                "Dropped bidding hot-refresh signal because the pending queue is full",
                {
                    laneKind: kind,
                    laneKey,
                    signature,
                    eventPriceWei: marketEvent.getUnitPrice().toString(),
                    pendingSignatureCount,
                    maxPendingSignatures,
                },
            );
            return false;
        }

        weakestPendingEvent.lane.pendingEvents.delete(
            weakestPendingEvent.signature,
        );
        log.debug(
            HOT_REFRESH_BACKPRESSURE_LOG_ACTION.PendingEventEvicted,
            "Evicted weaker bidding hot-refresh signal from the pending queue",
            {
                laneKind: kind,
                evictedLaneKey: weakestPendingEvent.laneKey,
                evictedSignature: weakestPendingEvent.signature,
                evictedEventPriceWei:
                    weakestPendingEvent.event.getUnitPrice().toString(),
                incomingLaneKey: laneKey,
                incomingSignature: signature,
                incomingEventPriceWei: marketEvent.getUnitPrice().toString(),
                pendingSignatureCount,
                maxPendingSignatures,
            },
        );
        return true;
    }

    private countPendingSignatures(kind: HotRefreshLaneKind): number {
        let count = 0;
        for (const lane of this.lanes.values()) {
            if (lane.kind === kind) {
                count += lane.pendingEvents.size;
            }
        }
        return count;
    }

    private findWeakestPendingEvent(
        kind: HotRefreshLaneKind,
    ): PendingEventReference | null {
        let weakest: PendingEventReference | null = null;
        for (const [laneKey, lane] of this.lanes.entries()) {
            if (lane.kind !== kind) {
                continue;
            }
            for (const [signature, event] of lane.pendingEvents.entries()) {
                if (
                    !weakest ||
                    event.getUnitPrice() < weakest.event.getUnitPrice()
                ) {
                    weakest = {
                        laneKey,
                        lane,
                        signature,
                        event,
                    };
                }
            }
        }
        return weakest;
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
