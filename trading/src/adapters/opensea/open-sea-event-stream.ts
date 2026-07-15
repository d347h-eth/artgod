import { EventCallback } from "../../application/use-cases/market/pipeline/pipeline.js";
import { MarketEvent, Scope, Type } from "../../domain/market/event.js";
import {
    BIDDING_LOG_COMPONENT,
    createBiddingComponentLogger,
    toErrorLogFields,
} from "../../utils/bidding-log.js";
import { observeBestEffort } from "../../utils/observe-best-effort.js";

type HandlerRegistrationFn = (
    client: OpenSeaStreamClient,
    collectionSlug: string,
    callback: (event: unknown) => void,
) => void | (() => void);

export interface OpenSeaStreamClient {
    onCollectionOffer(
        collectionSlug: string,
        callback: (event: unknown) => void,
    ): void | (() => void);
    onItemListed(
        collectionSlug: string,
        callback: (event: unknown) => void,
    ): void | (() => void);
    onItemSold(
        collectionSlug: string,
        callback: (event: unknown) => void,
    ): void | (() => void);
    onItemTransferred(
        collectionSlug: string,
        callback: (event: unknown) => void,
    ): void | (() => void);
    onItemReceivedBid(
        collectionSlug: string,
        callback: (event: unknown) => void,
    ): void | (() => void);
    onTraitOffer(
        collectionSlug: string,
        callback: (event: unknown) => void,
    ): void | (() => void);
}

export interface OpenSeaMarketEventFactoryPort {
    newMarketEvent(event: unknown): MarketEvent | null;
}

// Stream event outcomes describe whether an inbound OpenSea payload reached the market domain.
export const OPEN_SEA_STREAM_EVENT_OUTCOME = {
    Normalized: "normalized",
    NormalizationFailed: "normalization_failed",
} as const;

export type OpenSeaStreamEventOutcome =
    (typeof OPEN_SEA_STREAM_EVENT_OUTCOME)[keyof typeof OPEN_SEA_STREAM_EVENT_OUTCOME];

// OpenSeaEventStreamObservabilityPort reports inbound normalization, age, dispatch timing, and concurrency.
export interface OpenSeaEventStreamObservabilityPort {
    onStreamEvent(input: {
        eventType: Type | null;
        eventScope: Scope | null;
        outcome: OpenSeaStreamEventOutcome;
        ageMs?: number;
    }): void;
    onStreamDispatchFinished(input: {
        eventType: Type;
        eventScope: Scope;
        durationMs: number;
        succeeded: boolean;
    }): void;
    onStreamDispatchStarted(): void;
}

const log = createBiddingComponentLogger(
    BIDDING_LOG_COMPONENT.OpenSeaEventStream,
);

const OPEN_SEA_EVENT_STREAM_LOG_ACTION = {
    NormalizationFailed: "eventNormalizationFailed",
    ProcessingFailed: "eventProcessingFailed",
} as const;

// OpenSeaEventStream adapts OpenSea stream subscriptions into normalized MarketEvent callbacks.
export class OpenSeaEventStream {
    private readonly actions: HandlerRegistrationFn[] = [];
    private readonly unsubscriptions: Array<() => void> = [];
    private readonly activeDispatches = new Set<Promise<void>>();
    private acceptingEvents = false;

    constructor(
        private readonly streamClient: OpenSeaStreamClient,
        private readonly collectionSlug: string,
        private readonly marketEventFactory: OpenSeaMarketEventFactoryPort,
        private readonly observability?: OpenSeaEventStreamObservabilityPort,
    ) {}

    public withCollectionOffer(): this {
        this.storeRegistrationAction((client, collectionSlug, callback) =>
            client.onCollectionOffer(collectionSlug, callback),
        );
        return this;
    }

    public withItemListed(): this {
        this.storeRegistrationAction((client, collectionSlug, callback) =>
            client.onItemListed(collectionSlug, callback),
        );
        return this;
    }

    public withItemSold(): this {
        this.storeRegistrationAction((client, collectionSlug, callback) =>
            client.onItemSold(collectionSlug, callback),
        );
        return this;
    }

    public withItemReceivedBid(): this {
        this.storeRegistrationAction((client, collectionSlug, callback) =>
            client.onItemReceivedBid(collectionSlug, callback),
        );
        return this;
    }

    public withTraitOffer(): this {
        this.storeRegistrationAction((client, collectionSlug, callback) =>
            client.onTraitOffer(collectionSlug, callback),
        );
        return this;
    }

    public withItemTransferred(): this {
        this.storeRegistrationAction((client, collectionSlug, callback) =>
            client.onItemTransferred(collectionSlug, callback),
        );
        return this;
    }

    // registerHandler subscribes all selected OpenSea event types for the configured collection.
    public registerHandler(callback: EventCallback): void {
        this.acceptingEvents = true;
        const onEvent = this.callbackOnEvent(callback);
        this.actions.forEach((action) => {
            const unsubscribe = action(
                this.streamClient,
                this.collectionSlug,
                onEvent,
            );
            if (typeof unsubscribe === "function") {
                this.unsubscriptions.push(unsubscribe);
            }
        });
    }

    public dispose(): void {
        this.acceptingEvents = false;
        const errors: unknown[] = [];
        while (this.unsubscriptions.length > 0) {
            const unsubscribe = this.unsubscriptions.pop();
            try {
                unsubscribe?.();
            } catch (error) {
                errors.push(error);
            }
        }
        if (errors.length === 1) {
            throw errors[0];
        }
        if (errors.length > 1) {
            throw new AggregateError(
                errors,
                "Failed to remove OpenSea stream subscriptions",
            );
        }
    }

    // disposeAndDrain removes stream admission before waiting for admitted callbacks to settle.
    public async disposeAndDrain(): Promise<void> {
        let disposeError: unknown;
        try {
            this.dispose();
        } catch (error) {
            disposeError = error;
        }
        await Promise.allSettled(Array.from(this.activeDispatches));
        if (disposeError !== undefined) {
            throw disposeError;
        }
    }

    private storeRegistrationAction(
        registerMethod: HandlerRegistrationFn,
    ): void {
        this.actions.push(registerMethod);
    }

    // callbackOnEvent normalizes raw payloads before handing them to the market-event pipeline.
    private callbackOnEvent(callback: EventCallback): (event: unknown) => void {
        return (event: unknown) => {
            if (!this.acceptingEvents) {
                return;
            }

            let marketEvent: MarketEvent | null;
            try {
                marketEvent = this.marketEventFactory.newMarketEvent(event);
            } catch (error) {
                this.reportNormalizationFailure(event, error);
                return;
            }

            if (marketEvent === null) {
                this.reportNormalizationFailure(event);
                return;
            }

            const createdAtMs = Date.parse(marketEvent.getCreatedAt());
            observeBestEffort(() => {
                this.observability?.onStreamEvent({
                    eventType: marketEvent.getType(),
                    eventScope: marketEvent.getScope(),
                    outcome: OPEN_SEA_STREAM_EVENT_OUTCOME.Normalized,
                    ...(Number.isFinite(createdAtMs)
                        ? { ageMs: Math.max(0, Date.now() - createdAtMs) }
                        : {}),
                });
            });
            const dispatchStartedAt = Date.now();
            observeBestEffort(() => {
                this.observability?.onStreamDispatchStarted();
            });
            let succeeded = false;
            const dispatch = Promise.resolve()
                .then(() => callback(marketEvent))
                .then(() => {
                    succeeded = true;
                })
                .catch((error: unknown) => {
                    log.error(
                        OPEN_SEA_EVENT_STREAM_LOG_ACTION.ProcessingFailed,
                        "Failed to process OpenSea stream event",
                        {
                            collectionSlug: marketEvent.getCollectionSlug(),
                            eventType: marketEvent.getType(),
                            ...toErrorLogFields(error),
                        },
                    );
                })
                .finally(() => {
                    observeBestEffort(() => {
                        this.observability?.onStreamDispatchFinished({
                            eventType: marketEvent.getType(),
                            eventScope: marketEvent.getScope(),
                            durationMs: Date.now() - dispatchStartedAt,
                            succeeded,
                        });
                    });
                });
            this.activeDispatches.add(dispatch);
            void dispatch.then(
                () => this.activeDispatches.delete(dispatch),
                () => this.activeDispatches.delete(dispatch),
            );
        };
    }

    private reportNormalizationFailure(event: unknown, error?: unknown): void {
        observeBestEffort(() => {
            this.observability?.onStreamEvent({
                eventType: null,
                eventScope: null,
                outcome: OPEN_SEA_STREAM_EVENT_OUTCOME.NormalizationFailed,
            });
        });
        log.error(
            OPEN_SEA_EVENT_STREAM_LOG_ACTION.NormalizationFailed,
            "Could not normalize OpenSea stream event",
            {
                collectionSlug: this.collectionSlug,
                ...summarizeRawEvent(event),
                ...(error === undefined ? {} : toErrorLogFields(error)),
            },
        );
    }
}

function summarizeRawEvent(event: unknown): Record<string, unknown> {
    if (!isRecord(event)) {
        return { rawEventValueType: typeof event };
    }

    return {
        rawEventConstructor: event.constructor?.name,
        rawEventType:
            readString(event, "event_type") ?? readString(event, "type"),
        rawEventCollectionSlug:
            readString(event, "collection_slug") ??
            readString(event, "collection"),
        rawEventKeys: Object.keys(event).sort(),
    };
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return value !== null && typeof value === "object";
}

function readString(
    record: Record<string, unknown>,
    key: string,
): string | undefined {
    const value = record[key];
    return typeof value === "string" && value.trim().length > 0
        ? value
        : undefined;
}
