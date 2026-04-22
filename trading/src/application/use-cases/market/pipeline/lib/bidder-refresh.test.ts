import { strict as assert } from "node:assert";
import { describe, it } from "vitest";
import { MarketEvent } from "../../../../../domain/market/event.js";
import { PipelineBuilder } from "../pipeline.js";
import { BidderRefresh } from "./bidder-refresh.js";

class FakeRefreshPort {
    public events: MarketEvent[] = [];

    async refreshMatchingJobs(marketEvent: MarketEvent): Promise<void> {
        this.events.push(marketEvent);
    }
}

const sampleEvent = (): MarketEvent =>
    new MarketEvent(
        new Date().toISOString(),
        "item_received_bid" as any,
        "0xorder",
        "terraforms",
        "123",
        "0xmaker",
        1,
        "WETH",
        18,
    );

describe("BidderRefresh stage", () => {
    it("forwards market events to the bidder refresh port", async () => {
        const refreshPort = new FakeRefreshPort();
        const stage = new BidderRefresh("bidder", refreshPort as any);
        const pipeline = new PipelineBuilder().with(stage).build();

        await pipeline(sampleEvent());

        assert.equal(refreshPort.events.length, 1);
        assert.equal(refreshPort.events[0].getCollectionSlug(), "terraforms");
        assert.equal(refreshPort.events[0].getItemID(), "123");
    });
});
