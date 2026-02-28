import { describe, expect, it } from "vitest";
import { BidderIndex } from "../src/application/bidder-index.js";
import type { BidderIndexPort } from "../src/ports/bidder-index.js";

class FakeBidderIndex implements BidderIndexPort {
    constructor(private makers: string[]) {}
    async load(): Promise<Set<string>> {
        return new Set(this.makers);
    }
}

describe("BidderIndex", () => {
    it("stays quiet before first refresh", () => {
        const index = new BidderIndex(new FakeBidderIndex([]), 1);
        expect(index.shouldEmit("0xabc")).toBe(false);
        expect(index.isActive()).toBe(false);
    });

    it("stays quiet when refreshed to empty", async () => {
        const index = new BidderIndex(new FakeBidderIndex([]), 1);
        const state = await index.refresh();
        expect(state.ready).toBe(true);
        expect(state.size).toBe(0);
        expect(index.isActive()).toBe(false);
        expect(index.shouldEmit("0xabc")).toBe(false);
    });

    it("emits only for makers in the index", async () => {
        const maker = "0xA8DF7CfC1fa79979f0E84Dc7d4679B277BA84127";
        const index = new BidderIndex(new FakeBidderIndex([maker]), 1);
        const state = await index.refresh();
        expect(state.ready).toBe(true);
        expect(state.size).toBe(1);
        expect(index.isActive()).toBe(true);
        expect(index.shouldEmit(maker.toLowerCase())).toBe(true);
        expect(
            index.shouldEmit("0x0000000000000000000000000000000000000001"),
        ).toBe(false);
    });
});
