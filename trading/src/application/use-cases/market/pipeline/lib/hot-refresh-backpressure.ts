import {
    MarketEvent,
    Scope,
    Type,
} from "../../../../../domain/market/event.js";
import {
    BIDDING_LOG_COMPONENT,
    createBiddingComponentLogger,
    toErrorLogFields,
} from "../../../../../utils/bidding-log.js";
import { observeBestEffort } from "../../../../../utils/observe-best-effort.js";
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
    // Shares bidder execution capacity so inbound events cannot create unbounded downstream work.
    maxConcurrentPasses: number;
}

// Stable lane kinds separate collection-wide pressure from token-local pressure.
export const HOT_REFRESH_LANE_KIND = {
    Broad: "broad",
    Item: "item",
} as const;

export type HotRefreshLaneKind =
    (typeof HOT_REFRESH_LANE_KIND)[keyof typeof HOT_REFRESH_LANE_KIND];

// Stable signal outcomes describe queue admission without exposing lane identity.
export const HOT_REFRESH_SIGNAL_OUTCOME = {
    Queued: "queued",
    Coalesced: "coalesced",
    Dropped: "dropped",
    Evicted: "evicted",
} as const;

export type HotRefreshSignalOutcome =
    (typeof HOT_REFRESH_SIGNAL_OUTCOME)[keyof typeof HOT_REFRESH_SIGNAL_OUTCOME];

// HotRefreshBackpressureObservabilityPort reports aggregate lane pressure and pass latency.
export interface HotRefreshBackpressureObservabilityPort {
    onSignal(input: {
        laneKind: HotRefreshLaneKind;
        eventType: Type;
        outcome: HotRefreshSignalOutcome;
    }): void;
    onStateChanged(input: {
        laneKind: HotRefreshLaneKind;
        activeLanes: number;
        knownLanes: number;
        pendingEvents: number;
        pendingSignals: number;
    }): void;
    onPassFinished(input: {
        laneKind: HotRefreshLaneKind;
        durationMs: number;
        queueWaitMs: number;
        eventCount: number;
        signalCount: number;
        succeeded: boolean;
    }): void;
}

interface HotRefreshLane {
    running: boolean;
    pendingEvents: Map<string, PendingHotRefreshEvent>;
    pendingSignalCount: number;
    nextRunAt: number;
    timer?: ReturnType<typeof setTimeout>;
    kind: HotRefreshLaneKind;
}

interface PendingHotRefreshEvent {
    event: MarketEvent;
    signalCount: number;
    firstQueuedAt: number;
}

interface PendingEventReference {
    laneKey: string;
    lane: HotRefreshLane;
    signature: string;
    pending: PendingHotRefreshEvent;
}

interface ReadyHotRefreshLane {
    lane: HotRefreshLane;
    callback: EventCallback;
}

// PendingEventPriorityQueue keeps weakest-event admission independent of historical lane count.
class PendingEventPriorityQueue {
    private readonly heap: PendingEventReference[] = [];
    private readonly indexByPending = new Map<PendingHotRefreshEvent, number>();

    public add(reference: PendingEventReference): void {
        const index = this.heap.length;
        this.heap.push(reference);
        this.indexByPending.set(reference.pending, index);
        this.bubbleUp(index);
    }

    public update(pending: PendingHotRefreshEvent): void {
        const index = this.indexByPending.get(pending);
        if (index === undefined) {
            return;
        }

        const settledIndex = this.bubbleUp(index);
        this.bubbleDown(settledIndex);
    }

    public remove(pending: PendingHotRefreshEvent): void {
        const index = this.indexByPending.get(pending);
        if (index === undefined) {
            return;
        }

        const lastIndex = this.heap.length - 1;
        this.swap(index, lastIndex);
        this.heap.pop();
        this.indexByPending.delete(pending);

        if (index < this.heap.length) {
            const settledIndex = this.bubbleUp(index);
            this.bubbleDown(settledIndex);
        }
    }

    public peek(): PendingEventReference | null {
        return this.heap[0] ?? null;
    }

    public clear(): void {
        this.heap.length = 0;
        this.indexByPending.clear();
    }

    private bubbleUp(startIndex: number): number {
        let index = startIndex;
        while (index > 0) {
            const parentIndex = Math.floor((index - 1) / 2);
            if (!this.isWeaker(this.heap[index], this.heap[parentIndex])) {
                break;
            }
            this.swap(index, parentIndex);
            index = parentIndex;
        }
        return index;
    }

    private bubbleDown(startIndex: number): void {
        let index = startIndex;
        while (true) {
            const leftIndex = index * 2 + 1;
            const rightIndex = leftIndex + 1;
            let weakestIndex = index;

            if (
                leftIndex < this.heap.length &&
                this.isWeaker(this.heap[leftIndex], this.heap[weakestIndex])
            ) {
                weakestIndex = leftIndex;
            }
            if (
                rightIndex < this.heap.length &&
                this.isWeaker(this.heap[rightIndex], this.heap[weakestIndex])
            ) {
                weakestIndex = rightIndex;
            }
            if (weakestIndex === index) {
                return;
            }

            this.swap(index, weakestIndex);
            index = weakestIndex;
        }
    }

    private isWeaker(
        left: PendingEventReference,
        right: PendingEventReference,
    ): boolean {
        return (
            left.pending.event.getUnitPrice() <
            right.pending.event.getUnitPrice()
        );
    }

    private swap(leftIndex: number, rightIndex: number): void {
        if (leftIndex === rightIndex) {
            return;
        }

        const left = this.heap[leftIndex];
        const right = this.heap[rightIndex];
        this.heap[leftIndex] = right;
        this.heap[rightIndex] = left;
        this.indexByPending.set(right.pending, leftIndex);
        this.indexByPending.set(left.pending, rightIndex);
    }
}

interface HotRefreshLaneState {
    activeLanes: number;
    knownLanes: number;
    pendingEvents: number;
    pendingSignals: number;
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
    private readonly readyLanes = new Map<string, ReadyHotRefreshLane>();
    private readonly activePasses = new Set<Promise<void>>();
    private readonly cooldownLaneDeadlinesByKind: Record<
        HotRefreshLaneKind,
        Map<string, number>
    > = {
        [HOT_REFRESH_LANE_KIND.Broad]: new Map(),
        [HOT_REFRESH_LANE_KIND.Item]: new Map(),
    };
    private readonly cooldownCleanupTimersByKind: Partial<
        Record<HotRefreshLaneKind, ReturnType<typeof setTimeout>>
    > = {};
    private readonly pendingEventsByLaneKind: Record<
        HotRefreshLaneKind,
        PendingEventPriorityQueue
    > = {
        [HOT_REFRESH_LANE_KIND.Broad]: new PendingEventPriorityQueue(),
        [HOT_REFRESH_LANE_KIND.Item]: new PendingEventPriorityQueue(),
    };
    private readonly stateByLaneKind: Record<
        HotRefreshLaneKind,
        HotRefreshLaneState
    > = {
        [HOT_REFRESH_LANE_KIND.Broad]: createEmptyLaneState(),
        [HOT_REFRESH_LANE_KIND.Item]: createEmptyLaneState(),
    };
    private readonly broadCooldownMs: number;
    private readonly broadMaxPendingSignatures: number;
    private readonly itemCooldownMs: number;
    private readonly itemMaxPendingSignatures: number;
    private readonly maxConcurrentPasses: number;
    private activePassCount = 0;
    private stopped = false;

    constructor(
        private readonly name: string,
        options: HotRefreshBackpressureOptions,
        private readonly observability?: HotRefreshBackpressureObservabilityPort,
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
        if (
            !Number.isInteger(options.maxConcurrentPasses) ||
            options.maxConcurrentPasses <= 0
        ) {
            throw new Error(
                `[HotRefreshBackpressure] maxConcurrentPasses must be an integer > 0. received=${options.maxConcurrentPasses}`,
            );
        }

        this.broadCooldownMs = options.broadCooldownMs;
        this.broadMaxPendingSignatures = options.broadMaxPendingSignatures;
        this.itemCooldownMs = options.itemCooldownMs;
        this.itemMaxPendingSignatures = options.itemMaxPendingSignatures;
        this.maxConcurrentPasses = options.maxConcurrentPasses;
        this.reportState();
    }

    public getName(): string {
        return this.name;
    }

    // stop prevents new work, drops queued signals, and waits for active market actions to settle.
    public async stop(): Promise<void> {
        this.stopped = true;
        this.readyLanes.clear();
        this.clearRetainedCooldownLanes();
        for (const lane of this.lanes.values()) {
            if (lane.timer) {
                clearTimeout(lane.timer);
            }
            lane.timer = undefined;
            this.clearLanePending(lane);
        }
        this.reportState();

        await Promise.allSettled(Array.from(this.activePasses));

        this.lanes.clear();
        this.activePassCount = 0;
        for (const pendingEvents of Object.values(
            this.pendingEventsByLaneKind,
        )) {
            pendingEvents.clear();
        }
        for (const state of Object.values(this.stateByLaneKind)) {
            Object.assign(state, createEmptyLaneState());
        }
        this.reportState();
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
        const laneKind = isBroadHotRefreshEvent(marketEvent)
            ? HOT_REFRESH_LANE_KIND.Broad
            : HOT_REFRESH_LANE_KIND.Item;
        const signature = createEventSignature(marketEvent);
        let lane = this.lanes.get(laneKey);
        const existingPending = lane?.pendingEvents.get(signature);
        if (
            !existingPending &&
            !this.reservePendingSignature(
                laneKind,
                laneKey,
                signature,
                marketEvent,
            )
        ) {
            return;
        }
        lane ??= this.getLane(marketEvent);

        if (existingPending) {
            existingPending.event = selectConservativeEvent(
                existingPending.event,
                marketEvent,
            );
            existingPending.signalCount += 1;
            this.pendingEventsByLaneKind[lane.kind].update(existingPending);
        } else {
            const pending = {
                event: marketEvent,
                signalCount: 1,
                firstQueuedAt: Date.now(),
            };
            lane.pendingEvents.set(signature, pending);
            this.pendingEventsByLaneKind[lane.kind].add({
                laneKey,
                lane,
                signature,
                pending,
            });
            this.stateByLaneKind[lane.kind].pendingEvents += 1;
        }
        this.stateByLaneKind[lane.kind].pendingSignals += 1;
        lane.pendingSignalCount += 1;
        observeBestEffort(() => {
            this.observability?.onSignal({
                laneKind: lane.kind,
                eventType: marketEvent.getType(),
                outcome: existingPending
                    ? HOT_REFRESH_SIGNAL_OUTCOME.Coalesced
                    : HOT_REFRESH_SIGNAL_OUTCOME.Queued,
            });
        });
        this.reportState();

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
                if (lane.pendingEvents.size > 0) {
                    this.startLane(laneKey, lane, callback);
                } else {
                    this.removeLaneIfIdle(laneKey, lane);
                    this.reportState();
                }
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

        if (this.activePassCount >= this.maxConcurrentPasses) {
            this.readyLanes.set(laneKey, { lane, callback });
            log.debug(
                this.getQueuedLogAction(lane.kind),
                "Queued bidding hot-refresh lane until execution capacity is available",
                {
                    laneKey,
                    activePassCount: this.activePassCount,
                    maxConcurrentPasses: this.maxConcurrentPasses,
                    pendingEventCount: lane.pendingEvents.size,
                    pendingSignalCount: lane.pendingSignalCount,
                },
            );
            return;
        }

        this.readyLanes.delete(laneKey);
        const pendingEvents = Array.from(lane.pendingEvents.values());
        const events = pendingEvents.map((pending) => pending.event);
        const pendingSignalCount = lane.pendingSignalCount;
        const startedAt = Date.now();
        let firstQueuedAt = startedAt;
        for (const pending of pendingEvents) {
            firstQueuedAt = Math.min(firstQueuedAt, pending.firstQueuedAt);
        }
        const queueWaitMs = Math.max(0, startedAt - firstQueuedAt);
        this.clearLanePending(lane);
        lane.running = true;
        this.activePassCount += 1;
        this.stateByLaneKind[lane.kind].activeLanes += 1;
        this.reportState();

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

        const pass = (async () => {
            let succeeded = false;
            try {
                for (const event of events) {
                    await callback(event);
                }
                succeeded = true;
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
                this.activePassCount = Math.max(0, this.activePassCount - 1);
                this.stateByLaneKind[lane.kind].activeLanes = Math.max(
                    0,
                    this.stateByLaneKind[lane.kind].activeLanes - 1,
                );
                observeBestEffort(() => {
                    this.observability?.onPassFinished({
                        laneKind: lane.kind,
                        durationMs: Date.now() - startedAt,
                        queueWaitMs,
                        eventCount: events.length,
                        signalCount: pendingSignalCount,
                        succeeded,
                    });
                });
                if (this.stopped) {
                    this.clearLanePending(lane);
                    lane.timer = undefined;
                    this.reportState();
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
                } else {
                    // Retain only bounded cooldown identity after releasing the live lane.
                    this.retainLaneCooldown(laneKey, lane);
                }
                this.reportState();
                this.startReadyLanes();
            }
        })();
        this.activePasses.add(pass);
        void pass.then(
            () => this.activePasses.delete(pass),
            () => this.activePasses.delete(pass),
        );
    }

    private getLane(marketEvent: MarketEvent): HotRefreshLane {
        const laneKey = createLaneKey(marketEvent);
        let lane = this.lanes.get(laneKey);
        if (!lane) {
            const kind = isBroadHotRefreshEvent(marketEvent)
                ? HOT_REFRESH_LANE_KIND.Broad
                : HOT_REFRESH_LANE_KIND.Item;
            const retainedCooldownDeadline = this.takeRetainedCooldown(
                kind,
                laneKey,
            );
            lane = {
                running: false,
                pendingEvents: new Map(),
                pendingSignalCount: 0,
                nextRunAt: retainedCooldownDeadline ?? 0,
                kind,
            };
            this.lanes.set(laneKey, lane);
            if (retainedCooldownDeadline === undefined) {
                this.stateByLaneKind[lane.kind].knownLanes += 1;
            }
        }

        return lane;
    }

    private getCooldownMs(kind: HotRefreshLaneKind): number {
        return kind === HOT_REFRESH_LANE_KIND.Broad
            ? this.broadCooldownMs
            : this.itemCooldownMs;
    }

    private getMaxPendingSignatures(kind: HotRefreshLaneKind): number {
        return kind === HOT_REFRESH_LANE_KIND.Broad
            ? this.broadMaxPendingSignatures
            : this.itemMaxPendingSignatures;
    }

    private reservePendingSignature(
        kind: HotRefreshLaneKind,
        laneKey: string,
        signature: string,
        marketEvent: MarketEvent,
    ): boolean {
        const pendingSignatureCount = this.stateByLaneKind[kind].pendingEvents;
        const maxPendingSignatures = this.getMaxPendingSignatures(kind);
        if (pendingSignatureCount < maxPendingSignatures) {
            return true;
        }

        const weakestPendingEvent = this.pendingEventsByLaneKind[kind].peek();
        if (
            !weakestPendingEvent ||
            marketEvent.getUnitPrice() <=
                weakestPendingEvent.pending.event.getUnitPrice()
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
            observeBestEffort(() => {
                this.observability?.onSignal({
                    laneKind: kind,
                    eventType: marketEvent.getType(),
                    outcome: HOT_REFRESH_SIGNAL_OUTCOME.Dropped,
                });
            });
            this.reportState();
            return false;
        }

        weakestPendingEvent.lane.pendingEvents.delete(
            weakestPendingEvent.signature,
        );
        this.pendingEventsByLaneKind[kind].remove(weakestPendingEvent.pending);
        weakestPendingEvent.lane.pendingSignalCount = Math.max(
            0,
            weakestPendingEvent.lane.pendingSignalCount -
                weakestPendingEvent.pending.signalCount,
        );
        this.stateByLaneKind[kind].pendingEvents = Math.max(
            0,
            this.stateByLaneKind[kind].pendingEvents - 1,
        );
        this.stateByLaneKind[kind].pendingSignals = Math.max(
            0,
            this.stateByLaneKind[kind].pendingSignals -
                weakestPendingEvent.pending.signalCount,
        );
        log.debug(
            HOT_REFRESH_BACKPRESSURE_LOG_ACTION.PendingEventEvicted,
            "Evicted weaker bidding hot-refresh signal from the pending queue",
            {
                laneKind: kind,
                evictedLaneKey: weakestPendingEvent.laneKey,
                evictedSignature: weakestPendingEvent.signature,
                evictedEventPriceWei: weakestPendingEvent.pending.event
                    .getUnitPrice()
                    .toString(),
                incomingLaneKey: laneKey,
                incomingSignature: signature,
                incomingEventPriceWei: marketEvent.getUnitPrice().toString(),
                pendingSignatureCount,
                maxPendingSignatures,
            },
        );
        observeBestEffort(() => {
            this.observability?.onSignal({
                laneKind: kind,
                eventType: weakestPendingEvent.pending.event.getType(),
                outcome: HOT_REFRESH_SIGNAL_OUTCOME.Evicted,
            });
        });
        if (weakestPendingEvent.laneKey !== laneKey) {
            if (
                weakestPendingEvent.lane.pendingEvents.size === 0 &&
                !weakestPendingEvent.lane.running &&
                weakestPendingEvent.lane.timer
            ) {
                clearTimeout(weakestPendingEvent.lane.timer);
                weakestPendingEvent.lane.timer = undefined;
            }
            this.removeLaneIfIdle(
                weakestPendingEvent.laneKey,
                weakestPendingEvent.lane,
            );
        }
        this.reportState();
        return true;
    }

    private clearLanePending(lane: HotRefreshLane): void {
        const state = this.stateByLaneKind[lane.kind];
        state.pendingEvents = Math.max(
            0,
            state.pendingEvents - lane.pendingEvents.size,
        );
        state.pendingSignals = Math.max(
            0,
            state.pendingSignals - lane.pendingSignalCount,
        );
        for (const pending of lane.pendingEvents.values()) {
            this.pendingEventsByLaneKind[lane.kind].remove(pending);
        }
        lane.pendingEvents.clear();
        lane.pendingSignalCount = 0;
    }

    private removeLaneIfIdle(laneKey: string, lane: HotRefreshLane): void {
        if (
            lane.running ||
            lane.timer ||
            lane.pendingEvents.size > 0 ||
            this.lanes.get(laneKey) !== lane
        ) {
            return;
        }

        if (lane.nextRunAt > Date.now()) {
            this.retainLaneCooldown(laneKey, lane);
            return;
        }

        this.lanes.delete(laneKey);
        this.readyLanes.delete(laneKey);
        this.stateByLaneKind[lane.kind].knownLanes = Math.max(
            0,
            this.stateByLaneKind[lane.kind].knownLanes - 1,
        );
    }

    private retainLaneCooldown(laneKey: string, lane: HotRefreshLane): void {
        if (this.lanes.get(laneKey) !== lane) {
            return;
        }

        this.lanes.delete(laneKey);
        this.readyLanes.delete(laneKey);
        const retainedCooldowns = this.cooldownLaneDeadlinesByKind[lane.kind];
        retainedCooldowns.delete(laneKey);
        retainedCooldowns.set(laneKey, lane.nextRunAt);

        // Reuse the kind's pressure budget so cooldown identity cannot grow without bound.
        const maxRetainedCooldowns = this.getMaxPendingSignatures(lane.kind);
        while (retainedCooldowns.size > maxRetainedCooldowns) {
            const oldestLaneKey = retainedCooldowns.keys().next();
            if (oldestLaneKey.done) {
                break;
            }
            retainedCooldowns.delete(oldestLaneKey.value);
            // Under identity flood, memory safety deliberately wins over the oldest remaining cooldown.
            // A later repeat for that forgotten identity may therefore run before its old deadline.
            this.stateByLaneKind[lane.kind].knownLanes = Math.max(
                0,
                this.stateByLaneKind[lane.kind].knownLanes - 1,
            );
        }
        this.scheduleRetainedCooldownCleanup(lane.kind);
    }

    private takeRetainedCooldown(
        kind: HotRefreshLaneKind,
        laneKey: string,
    ): number | undefined {
        const retainedCooldowns = this.cooldownLaneDeadlinesByKind[kind];
        const deadline = retainedCooldowns.get(laneKey);
        if (deadline === undefined) {
            return undefined;
        }

        retainedCooldowns.delete(laneKey);
        if (retainedCooldowns.size === 0) {
            const cleanupTimer = this.cooldownCleanupTimersByKind[kind];
            if (cleanupTimer) {
                clearTimeout(cleanupTimer);
                this.cooldownCleanupTimersByKind[kind] = undefined;
            }
        }
        return deadline;
    }

    private scheduleRetainedCooldownCleanup(kind: HotRefreshLaneKind): void {
        if (
            this.stopped ||
            this.cooldownCleanupTimersByKind[kind] ||
            this.cooldownLaneDeadlinesByKind[kind].size === 0
        ) {
            return;
        }

        const earliestDeadline = this.cooldownLaneDeadlinesByKind[kind]
            .values()
            .next();
        if (earliestDeadline.done) {
            return;
        }
        this.cooldownCleanupTimersByKind[kind] = setTimeout(
            () => {
                this.cooldownCleanupTimersByKind[kind] = undefined;
                this.expireRetainedCooldowns(kind);
            },
            Math.max(0, earliestDeadline.value - Date.now()),
        );
    }

    private expireRetainedCooldowns(kind: HotRefreshLaneKind): void {
        const retainedCooldowns = this.cooldownLaneDeadlinesByKind[kind];
        const now = Date.now();
        let expiredCount = 0;
        for (const [laneKey, deadline] of retainedCooldowns) {
            if (deadline > now) {
                break;
            }
            retainedCooldowns.delete(laneKey);
            expiredCount += 1;
        }

        if (expiredCount > 0) {
            this.stateByLaneKind[kind].knownLanes = Math.max(
                0,
                this.stateByLaneKind[kind].knownLanes - expiredCount,
            );
            this.reportState();
        }
        this.scheduleRetainedCooldownCleanup(kind);
    }

    private clearRetainedCooldownLanes(): void {
        for (const kind of Object.values(HOT_REFRESH_LANE_KIND)) {
            const cleanupTimer = this.cooldownCleanupTimersByKind[kind];
            if (cleanupTimer) {
                clearTimeout(cleanupTimer);
                this.cooldownCleanupTimersByKind[kind] = undefined;
            }
            const retainedCooldowns = this.cooldownLaneDeadlinesByKind[kind];
            this.stateByLaneKind[kind].knownLanes = Math.max(
                0,
                this.stateByLaneKind[kind].knownLanes - retainedCooldowns.size,
            );
            retainedCooldowns.clear();
        }
    }

    private startReadyLanes(): void {
        while (
            !this.stopped &&
            this.activePassCount < this.maxConcurrentPasses
        ) {
            const nextEntry = this.readyLanes.entries().next();
            if (nextEntry.done) {
                return;
            }

            const [laneKey, readyLane] = nextEntry.value;
            this.readyLanes.delete(laneKey);
            if (
                readyLane.lane.running ||
                readyLane.lane.timer ||
                readyLane.lane.pendingEvents.size === 0
            ) {
                this.removeLaneIfIdle(laneKey, readyLane.lane);
                continue;
            }

            this.startLane(laneKey, readyLane.lane, readyLane.callback);
        }
    }

    private reportState(): void {
        for (const laneKind of Object.values(HOT_REFRESH_LANE_KIND)) {
            const state = this.stateByLaneKind[laneKind];
            observeBestEffort(() => {
                this.observability?.onStateChanged({
                    laneKind,
                    ...state,
                });
            });
        }
    }

    private getQueuedLogAction(kind: HotRefreshLaneKind): string {
        return kind === HOT_REFRESH_LANE_KIND.Broad
            ? HOT_REFRESH_BACKPRESSURE_LOG_ACTION.BroadEventQueued
            : HOT_REFRESH_BACKPRESSURE_LOG_ACTION.ItemEventQueued;
    }

    private getStartedLogAction(kind: HotRefreshLaneKind): string {
        return kind === HOT_REFRESH_LANE_KIND.Broad
            ? HOT_REFRESH_BACKPRESSURE_LOG_ACTION.BroadPassStarted
            : HOT_REFRESH_BACKPRESSURE_LOG_ACTION.ItemPassStarted;
    }

    private getFailedLogAction(kind: HotRefreshLaneKind): string {
        return kind === HOT_REFRESH_LANE_KIND.Broad
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

function createEmptyLaneState(): HotRefreshLaneState {
    return {
        activeLanes: 0,
        knownLanes: 0,
        pendingEvents: 0,
        pendingSignals: 0,
    };
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
