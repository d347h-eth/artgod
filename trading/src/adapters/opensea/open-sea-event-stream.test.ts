import { strict as assert } from "node:assert";
import { describe, it } from "vitest";
import { MarketEvent, Scope, Type } from "../../domain/market/event.js";
import {
    OPEN_SEA_STREAM_EVENT_OUTCOME,
    OpenSeaEventStream,
    type OpenSeaStreamEventOutcome,
} from "./open-sea-event-stream.js";
import { OpenSeaMarketEventFactory } from "./open-sea-market-event-factory.js";

class FakeStreamClient {
    public callbacks: Record<string, (event: unknown) => void> = {};
    public subscriptions: Array<{ event: string; collectionSlug: string }> = [];
    public unsubscribed: string[] = [];

    public onCollectionOffer(
        collectionSlug: string,
        callback: (event: unknown) => void,
    ): () => void {
        this.subscriptions.push({ event: "collection_offer", collectionSlug });
        this.callbacks.collection_offer = callback;
        return () => this.unsubscribed.push("collection_offer");
    }

    public onItemListed(
        collectionSlug: string,
        callback: (event: unknown) => void,
    ): () => void {
        this.subscriptions.push({ event: "item_listed", collectionSlug });
        this.callbacks.item_listed = callback;
        return () => this.unsubscribed.push("item_listed");
    }

    public onItemSold(
        collectionSlug: string,
        callback: (event: unknown) => void,
    ): () => void {
        this.subscriptions.push({ event: "item_sold", collectionSlug });
        this.callbacks.item_sold = callback;
        return () => this.unsubscribed.push("item_sold");
    }

    public onItemTransferred(
        collectionSlug: string,
        callback: (event: unknown) => void,
    ): () => void {
        this.subscriptions.push({ event: "item_transferred", collectionSlug });
        this.callbacks.item_transferred = callback;
        return () => this.unsubscribed.push("item_transferred");
    }

    public onItemReceivedBid(
        collectionSlug: string,
        callback: (event: unknown) => void,
    ): () => void {
        this.subscriptions.push({ event: "item_received_bid", collectionSlug });
        this.callbacks.item_received_bid = callback;
        return () => this.unsubscribed.push("item_received_bid");
    }

    public onTraitOffer(
        collectionSlug: string,
        callback: (event: unknown) => void,
    ): () => void {
        this.subscriptions.push({ event: "trait_offer", collectionSlug });
        this.callbacks.trait_offer = callback;
        return () => this.unsubscribed.push("trait_offer");
    }
}

class FakeMarketEventFactory {
    public calls: unknown[] = [];

    public newMarketEvent(event: unknown): MarketEvent | null {
        this.calls.push(event);
        return new MarketEvent(
            new Date().toISOString(),
            Type.ItemReceivedBid,
            "0xhash",
            "terraforms",
            "123",
            "0xmaker",
            1,
            "WETH",
            18,
            Scope.Item,
        );
    }
}

describe("OpenSeaEventStream", () => {
    it("registers the selected OpenSea event subscriptions for the configured collection", () => {
        const streamClient = new FakeStreamClient();
        const eventStream = new OpenSeaEventStream(
            streamClient as any,
            "terraforms",
            new FakeMarketEventFactory(),
        )
            .withItemReceivedBid()
            .withCollectionOffer()
            .withTraitOffer();

        eventStream.registerHandler(async () => {});

        assert.deepEqual(streamClient.subscriptions, [
            { event: "item_received_bid", collectionSlug: "terraforms" },
            { event: "collection_offer", collectionSlug: "terraforms" },
            { event: "trait_offer", collectionSlug: "terraforms" },
        ]);
    });

    it("normalizes raw OpenSea events before forwarding them to the pipeline callback", async () => {
        const streamClient = new FakeStreamClient();
        const factory = new FakeMarketEventFactory();
        const received: MarketEvent[] = [];
        const observedEvents: Array<{
            eventType: Type | null;
            eventScope: Scope | null;
            outcome: OpenSeaStreamEventOutcome;
            ageMs?: number;
        }> = [];
        const dispatches: boolean[] = [];
        const activeDispatches: number[] = [];
        let activeDispatchCount = 0;
        const eventStream = new OpenSeaEventStream(
            streamClient as any,
            "terraforms",
            factory,
            {
                onStreamEvent: (input) => observedEvents.push(input),
                onStreamDispatchFinished: (input) => {
                    activeDispatchCount = Math.max(0, activeDispatchCount - 1);
                    activeDispatches.push(activeDispatchCount);
                    dispatches.push(input.succeeded);
                },
                onStreamDispatchStarted: () => {
                    activeDispatchCount += 1;
                    activeDispatches.push(activeDispatchCount);
                },
            },
        ).withItemReceivedBid();

        eventStream.registerHandler(async (event) => {
            received.push(event);
        });

        const rawEvent = { event_type: "item_received_bid" };
        streamClient.callbacks.item_received_bid(rawEvent);
        await new Promise((resolve) => setTimeout(resolve, 0));

        assert.deepEqual(factory.calls, [rawEvent]);
        assert.equal(received.length, 1);
        assert.equal(received[0]?.getCollectionSlug(), "terraforms");
        assert.equal(received[0]?.getItemID(), "123");
        assert.equal(observedEvents.length, 1);
        assert.deepEqual(
            observedEvents.map(({ eventType, eventScope, outcome }) => ({
                eventType,
                eventScope,
                outcome,
            })),
            [
                {
                    eventType: Type.ItemReceivedBid,
                    eventScope: Scope.Item,
                    outcome: OPEN_SEA_STREAM_EVENT_OUTCOME.Normalized,
                },
            ],
        );
        assert.ok(observedEvents[0]!.ageMs! >= 0);
        assert.deepEqual(dispatches, [true]);
        assert.deepEqual(activeDispatches, [1, 0]);
    });

    it("records malformed event normalization without throwing through the stream callback", async () => {
        const streamClient = new FakeStreamClient();
        const outcomes: OpenSeaStreamEventOutcome[] = [];
        let dispatchStarts = 0;
        let dispatchFinishes = 0;
        let callbackCalls = 0;
        const eventStream = new OpenSeaEventStream(
            streamClient as any,
            "terraforms",
            new OpenSeaMarketEventFactory(),
            {
                onStreamEvent: ({ outcome }) => outcomes.push(outcome),
                onStreamDispatchStarted: () => {
                    dispatchStarts += 1;
                },
                onStreamDispatchFinished: () => {
                    dispatchFinishes += 1;
                },
            },
        ).withItemReceivedBid();
        eventStream.registerHandler(async () => {
            callbackCalls += 1;
        });

        const malformedEvent = {
            event_type: Type.ItemReceivedBid,
            payload: {
                base_price: "not-a-bigint",
                collection: { slug: "terraforms" },
            },
        };

        assert.doesNotThrow(() =>
            streamClient.callbacks.item_received_bid(malformedEvent),
        );
        await eventStream.disposeAndDrain();

        assert.deepEqual(outcomes, [
            OPEN_SEA_STREAM_EVENT_OUTCOME.NormalizationFailed,
        ]);
        assert.equal(callbackCalls, 0);
        assert.equal(dispatchStarts, 0);
        assert.equal(dispatchFinishes, 0);
    });

    it("disposes all registered OpenSea subscriptions", () => {
        const streamClient = new FakeStreamClient();
        const eventStream = new OpenSeaEventStream(
            streamClient as any,
            "terraforms",
            new FakeMarketEventFactory(),
        )
            .withItemReceivedBid()
            .withTraitOffer();

        eventStream.registerHandler(async () => {});
        eventStream.dispose();

        assert.deepEqual(streamClient.unsubscribed.sort(), [
            "item_received_bid",
            "trait_offer",
        ]);
    });

    it("unsubscribes before waiting for active dispatches to settle", async () => {
        const streamClient = new FakeStreamClient();
        let releaseDispatch!: () => void;
        const dispatchGate = new Promise<void>((resolve) => {
            releaseDispatch = resolve;
        });
        const eventStream = new OpenSeaEventStream(
            streamClient as any,
            "terraforms",
            new FakeMarketEventFactory(),
        ).withItemReceivedBid();
        eventStream.registerHandler(async () => {
            await dispatchGate;
        });
        streamClient.callbacks.item_received_bid({});

        let drained = false;
        const drain = eventStream.disposeAndDrain().then(() => {
            drained = true;
        });
        await Promise.resolve();

        assert.deepEqual(streamClient.unsubscribed, ["item_received_bid"]);
        assert.equal(drained, false);
        releaseDispatch();
        await drain;
        assert.equal(drained, true);
    });

    it("attempts every unsubscribe and drains active dispatches before reporting teardown failures", async () => {
        const streamClient = new FakeStreamClient();
        const unsubscribeAttempts: string[] = [];
        streamClient.onItemReceivedBid = (_collectionSlug, callback) => {
            streamClient.callbacks.item_received_bid = callback;
            return () => {
                unsubscribeAttempts.push("item_received_bid");
                throw new Error("item unsubscribe failed");
            };
        };
        streamClient.onTraitOffer = (_collectionSlug, callback) => {
            streamClient.callbacks.trait_offer = callback;
            return () => {
                unsubscribeAttempts.push("trait_offer");
                throw new Error("trait unsubscribe failed");
            };
        };
        let releaseDispatch!: () => void;
        const dispatchGate = new Promise<void>((resolve) => {
            releaseDispatch = resolve;
        });
        let dispatchFinished = false;
        const eventStream = new OpenSeaEventStream(
            streamClient as any,
            "terraforms",
            new FakeMarketEventFactory(),
        )
            .withItemReceivedBid()
            .withTraitOffer();
        eventStream.registerHandler(async () => {
            await dispatchGate;
            dispatchFinished = true;
        });
        streamClient.callbacks.item_received_bid({});

        let drainSettled = false;
        const drainResult = eventStream.disposeAndDrain().then(
            () => null,
            (error: unknown) => error,
        );
        void drainResult.finally(() => {
            drainSettled = true;
        });
        await Promise.resolve();

        assert.deepEqual(unsubscribeAttempts.sort(), [
            "item_received_bid",
            "trait_offer",
        ]);
        assert.equal(drainSettled, false);

        releaseDispatch();
        const error = await drainResult;

        assert.equal(dispatchFinished, true);
        assert.ok(error instanceof AggregateError);
        assert.equal(error.errors.length, 2);
    });

    it("rejects callbacks that arrive after stream admission closes", async () => {
        const streamClient = new FakeStreamClient();
        const factory = new FakeMarketEventFactory();
        let dispatchCount = 0;
        const eventStream = new OpenSeaEventStream(
            streamClient as any,
            "terraforms",
            factory,
        ).withItemReceivedBid();
        eventStream.registerHandler(async () => {
            dispatchCount += 1;
        });

        await eventStream.disposeAndDrain();
        streamClient.callbacks.item_received_bid({ late: true });
        await Promise.resolve();

        assert.deepEqual(factory.calls, []);
        assert.equal(dispatchCount, 0);
    });

    it("keeps dispatch behavior authoritative when observability throws", async () => {
        const streamClient = new FakeStreamClient();
        let dispatchCount = 0;
        const eventStream = new OpenSeaEventStream(
            streamClient as any,
            "terraforms",
            new FakeMarketEventFactory(),
            {
                onStreamEvent: () => {
                    throw new Error("stream event metrics unavailable");
                },
                onStreamDispatchStarted: () => {
                    throw new Error("stream active metrics unavailable");
                },
                onStreamDispatchFinished: () => {
                    throw new Error("stream duration metrics unavailable");
                },
            },
        ).withItemReceivedBid();
        eventStream.registerHandler(async () => {
            dispatchCount += 1;
        });

        streamClient.callbacks.item_received_bid({});
        await eventStream.disposeAndDrain();

        assert.equal(dispatchCount, 1);
    });
});
