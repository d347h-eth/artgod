import { inspect } from "node:util";
import { logger } from "@artgod/shared/utils/logger";
import { EventCallback } from "../../application/use-cases/market/pipeline/pipeline.js";
import { MarketEvent } from "../../domain/market/event.js";

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

// OpenSeaEventStream adapts OpenSea stream subscriptions into normalized MarketEvent callbacks.
export class OpenSeaEventStream {
    private readonly actions: HandlerRegistrationFn[] = [];
    private readonly unsubscriptions: Array<() => void> = [];

    constructor(
        private readonly streamClient: OpenSeaStreamClient,
        private readonly collectionSlug: string,
        private readonly marketEventFactory: OpenSeaMarketEventFactoryPort,
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
        while (this.unsubscriptions.length > 0) {
            const unsubscribe = this.unsubscriptions.pop();
            unsubscribe?.();
        }
    }

    private storeRegistrationAction(registerMethod: HandlerRegistrationFn): void {
        this.actions.push(registerMethod);
    }

    // callbackOnEvent normalizes raw payloads before handing them to the market-event pipeline.
    private callbackOnEvent(
        callback: EventCallback,
    ): (event: unknown) => void {
        return (event: unknown) => {
            const marketEvent = this.marketEventFactory.newMarketEvent(event);
            if (marketEvent === null) {
                logger.error(
                    "[OpenSeaEventStream] Could not normalize OpenSea stream event",
                    {
                        payload: inspect(event),
                    },
                );
                return;
            }

            void callback(marketEvent).catch((error: unknown) => {
                const message =
                    error instanceof Error ? error.message : String(error);
                logger.error(
                    `[OpenSeaEventStream] Failed to process ${marketEvent.getType()} for ${marketEvent.getCollectionSlug()}: ${message}`,
                );
            });
        };
    }
}
