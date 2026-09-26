import { strict as assert } from "node:assert";
import { describe, it } from "vitest";
import { Scope } from "../../domain/market/event.js";
import { OpenSeaMarketEventFactory } from "./open-sea-market-event-factory.js";
import { OPENSEA_STREAM_EVENT_TYPE } from "@artgod/shared/opensea/payload";

const CONTRACT = "0x1111111111111111111111111111111111111111";
const MAKER = "0x2222222222222222222222222222222222222222";

function baseEvent(): Record<string, unknown> {
    return {
        event_type: "item_sold",
        payload: {
            event_timestamp: new Date().toISOString(),
            order_hash: "0xabc",
            collection: { slug: "sluggy" },
            item: { nft_id: `ethereum/${CONTRACT}/1234` },
            maker: { address: MAKER },
            quantity: 2,
            payment_token: {
                symbol: "ETH",
                decimals: 18,
                address: "0x0000000000000000000000000000000000000000",
            },
            is_private: false,
            base_price: "0",
        },
    };
}

describe("OpenSeaMarketEventFactory", () => {
    it("retains token wake-up hints when a sale has no order hash", () => {
        const event = baseEvent();
        const payload = event.payload as Record<string, unknown>;
        delete payload.order_hash;
        payload.maker = MAKER;
        const mapped = new OpenSeaMarketEventFactory().newMarketEvent(event);
        assert.equal(mapped?.getType(), OPENSEA_STREAM_EVENT_TYPE.ItemSold);
        assert.equal(mapped?.getItemId(), "1234");
        assert.equal(mapped?.getMaker(), MAKER);
        assert.equal(mapped?.getOrderHash(), "");
    });

    it("does not turn a malformed NFT id into a different token hint", () => {
        const event = baseEvent();
        (event.payload as Record<string, unknown>).item = {
            nft_id: `ethereum/${CONTRACT}/1234/5678`,
        };
        const mapped = new OpenSeaMarketEventFactory().newMarketEvent(event);
        assert.equal(mapped?.hasExplicitTokenId(), false);
    });

    it("maps item_sold and computes unit price", () => {
        const event = baseEvent();
        event.event_type = "item_sold";
        (event.payload as Record<string, unknown>).sale_price =
            "2000000000000000000";

        const factory = new OpenSeaMarketEventFactory();
        const marketEvent = factory.newMarketEvent(event);

        assert.ok(marketEvent);
        assert.equal(marketEvent?.getItemID(), "1234");
        assert.equal(marketEvent?.getQuantity(), 2);
        assert.equal(marketEvent?.getUnitPrice(), 1000000000000000000n);
        assert.equal(marketEvent?.getPaymentTokenSymbol(), "ETH");
        assert.equal(marketEvent?.getScope(), Scope.Unknown);
    });

    it("maps item_transferred with minimal fields", () => {
        const event = baseEvent();
        event.event_type = "item_transferred";

        const factory = new OpenSeaMarketEventFactory();
        const marketEvent = factory.newMarketEvent(event);

        assert.equal(marketEvent?.getItemID(), "1234");
        assert.equal(marketEvent?.getQuantity(), 2);
    });

    it("maps collection_offer as collection scope without explicit token id", () => {
        const event = baseEvent();
        event.event_type = "collection_offer";
        (event.payload as Record<string, unknown>).base_price =
            "3000000000000000000";
        (event.payload as Record<string, unknown>).trait_criteria = {
            traits: [
                { trait_type: "Biome", trait_value: "53" },
                { type: "Zone", value: "8" },
            ],
        };

        const factory = new OpenSeaMarketEventFactory();
        const marketEvent = factory.newMarketEvent(event);

        assert.equal(marketEvent?.getScope(), Scope.Collection);
        assert.equal(marketEvent?.getItemID(), "");
        assert.deepEqual(marketEvent?.getTraitCriteria(), [
            { type: "Biome", value: "53" },
            { type: "Zone", value: "8" },
        ]);
        assert.equal(marketEvent?.getUnitPrice(), 1500000000000000000n);
    });

    it("maps trait_offer and normalizes multiple trait criteria", () => {
        const event = baseEvent();
        event.event_type = "trait_offer";
        (event.payload as Record<string, unknown>).base_price =
            "4000000000000000000";
        (event.payload as Record<string, unknown>).trait_criteria = {
            traits: [
                { type: "Biome", value: "53" },
                { trait_type: "Chroma", trait_value: "Flow" },
            ],
        };

        const factory = new OpenSeaMarketEventFactory();
        const marketEvent = factory.newMarketEvent(event);

        assert.equal(marketEvent?.getScope(), Scope.Trait);
        assert.equal(marketEvent?.getItemID(), "");
        assert.deepEqual(marketEvent?.getTraitCriteria(), [
            { type: "Biome", value: "53" },
            { type: "Chroma", value: "Flow" },
        ]);
        assert.equal(marketEvent?.getUnitPrice(), 2000000000000000000n);
    });

    it("maps trait_offer criteria from trait_criteria_list when trait_criteria is null", () => {
        const event = baseEvent();
        event.event_type = "trait_offer";
        (event.payload as Record<string, unknown>).base_price =
            "4000000000000000000";
        (event.payload as Record<string, unknown>).trait_criteria = null;
        (event.payload as Record<string, unknown>).trait_criteria_list = [
            { trait_type: "Biome", trait_name: "81" },
            { trait_type: "Mode", trait_name: "Terrain" },
        ];

        const factory = new OpenSeaMarketEventFactory();
        const marketEvent = factory.newMarketEvent(event);

        assert.equal(marketEvent?.getScope(), Scope.Trait);
        assert.deepEqual(marketEvent?.getTraitCriteria(), [
            { type: "Biome", value: "81" },
            { type: "Mode", value: "Terrain" },
        ]);
        assert.equal(marketEvent?.getUnitPrice(), 2000000000000000000n);
    });

    it("returns null for unknown event types", () => {
        const event = baseEvent();
        event.event_type = "unknown_type";

        const factory = new OpenSeaMarketEventFactory();
        assert.equal(factory.newMarketEvent(event), null);
    });

    it("maps item_listed payment token and privacy fields", () => {
        const factory = new OpenSeaMarketEventFactory();
        const marketEvent = factory.newMarketEvent(baseEvent());

        assert.equal(
            marketEvent?.getPaymentTokenAddress(),
            "0x0000000000000000000000000000000000000000",
        );
        assert.equal(marketEvent?.isPrivateListing(), false);
    });
});
