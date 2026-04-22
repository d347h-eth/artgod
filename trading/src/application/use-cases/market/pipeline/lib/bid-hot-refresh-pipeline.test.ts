import { strict as assert } from "node:assert";
import { describe, it } from "vitest";
import { MarketEvent, Scope, Type } from "../../../../../domain/market/event.js";
import { PipelineBuilder } from "../pipeline.js";
import { BidderRefresh } from "./bidder-refresh.js";
import { CollectionOfferSnapshotRefresh } from "./collection-offer-snapshot-refresh.js";
import { AttrFilter } from "./attr-filter.js";

class FakeCollectionOfferRefreshPort {
    public calls: string[] = [];
    public gate?: Promise<void>;

    public requestRefresh(): void {}

    public async refreshAndWait(collectionSlug: string): Promise<void> {
        this.calls.push(`refresh:start:${collectionSlug}`);
        if (this.gate) {
            await this.gate;
        }
        this.calls.push(`refresh:end:${collectionSlug}`);
    }
}

class FakeBidderRefreshPort {
    public calls: string[] = [];

    public async refreshMatchingJobs(marketEvent: MarketEvent): Promise<void> {
        this.calls.push(`bidder:${marketEvent.getCollectionSlug()}`);
    }
}

function sampleEvent(maker: string = "0xother"): MarketEvent {
    const event = new MarketEvent(
        new Date().toISOString(),
        Type.TraitOffer,
        "0xhash",
        "terraforms",
        "",
        maker,
        1,
        "WETH",
        18,
        Scope.Trait,
        [{ type: "Biome", value: "53" }],
    );
    event.setTotalPrice(1n);
    return event;
}

describe("bid hot-refresh pipeline", () => {
    it("blocks bidder hot refresh until the snapshot refresh completes", async () => {
        const refreshPort = new FakeCollectionOfferRefreshPort();
        const bidderRefreshPort = new FakeBidderRefreshPort();
        let releaseGate!: () => void;
        refreshPort.gate = new Promise<void>((resolve) => {
            releaseGate = resolve;
        });

        const opponentOnly = new AttrFilter("opponent-only");
        opponentOnly.addCriteria(
            "opponent-bids",
            (event) => event.getMaker().toLowerCase() !== "0xmaker",
        );

        const pipeline = new PipelineBuilder()
            .with(opponentOnly)
            .with(
                new CollectionOfferSnapshotRefresh(
                    "criteria-offer-cache-refresh",
                    refreshPort,
                    () => "matchedTraits=Biome",
                ),
            )
            .with(new BidderRefresh("bidder-hot-refresh", bidderRefreshPort))
            .build();

        const runPromise = pipeline(sampleEvent());
        await new Promise((resolve) => setTimeout(resolve, 0));

        assert.deepEqual(refreshPort.calls, ["refresh:start:terraforms"]);
        assert.deepEqual(bidderRefreshPort.calls, []);

        releaseGate();
        await runPromise;

        assert.deepEqual(refreshPort.calls, [
            "refresh:start:terraforms",
            "refresh:end:terraforms",
        ]);
        assert.deepEqual(bidderRefreshPort.calls, ["bidder:terraforms"]);
    });

    it("drops own-bid events before snapshot refresh and bidder hot refresh", async () => {
        const refreshPort = new FakeCollectionOfferRefreshPort();
        const bidderRefreshPort = new FakeBidderRefreshPort();

        const opponentOnly = new AttrFilter("opponent-only");
        opponentOnly.addCriteria(
            "opponent-bids",
            (event) => event.getMaker().toLowerCase() !== "0xmaker",
        );

        const pipeline = new PipelineBuilder()
            .with(opponentOnly)
            .with(
                new CollectionOfferSnapshotRefresh(
                    "criteria-offer-cache-refresh",
                    refreshPort,
                    () => "matchedTraits=Biome",
                ),
            )
            .with(new BidderRefresh("bidder-hot-refresh", bidderRefreshPort))
            .build();

        await pipeline(sampleEvent("0xmaker"));

        assert.deepEqual(refreshPort.calls, []);
        assert.deepEqual(bidderRefreshPort.calls, []);
    });
});
