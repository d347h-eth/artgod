import { strict as assert } from "node:assert";
import { describe, it } from "vitest";
import { MarketEvent, Scope, Type } from "../../../../../domain/market/event.js";
import { PipelineBuilder } from "../pipeline.js";
import { AttrFilter } from "./attr-filter.js";

function sampleEvent(): MarketEvent {
    const event = new MarketEvent(
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
    event.setTotalPrice(1n);
    return event;
}

describe("AttrFilter", () => {
    it("forwards a market event when any configured predicate matches", async () => {
        const seen: MarketEvent[] = [];
        const filter = new AttrFilter("opponent-only");
        filter.addCriteria("maker", (event) => event.getMaker() === "0xmaker");

        const pipeline = new PipelineBuilder()
            .with(filter)
            .build();

        const wrapped = async (event: MarketEvent) => {
            seen.push(event);
        };

        await filter.getWrappingFn()(wrapped)(sampleEvent());
        assert.equal(seen.length, 1);
        assert.equal(seen[0]?.getOrderHash(), "0xhash");
        await pipeline(sampleEvent());
    });

    it("drops a market event when none of the predicates match", async () => {
        const seen: MarketEvent[] = [];
        const filter = new AttrFilter("opponent-only");
        filter.addCriteria("maker", (event) => event.getMaker() === "0xother");

        await filter.getWrappingFn()(async (event) => {
            seen.push(event);
        })(sampleEvent());

        assert.deepEqual(seen, []);
    });
});
