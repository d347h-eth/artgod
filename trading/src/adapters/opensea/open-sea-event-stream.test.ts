import { strict as assert } from "node:assert";
import { describe, it } from "vitest";
import { MarketEvent, Scope, Type } from "../../domain/market/event.js";
import { OpenSeaEventStream } from "./open-sea-event-stream.js";

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
        const eventStream = new OpenSeaEventStream(
            streamClient as any,
            "terraforms",
            factory,
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
});
