import { describe, expect, it } from "vitest";
import fs from "node:fs/promises";
import {
    normalizeOpenSeaEvent,
    normalizeOpenSeaMakerUpdate,
    normalizeOpenSeaMetadataRefresh,
    normalizeOpenSeaOrderUpdate,
} from "../src/application/offchain/opensea-normalize.js";
import { resolveFixturePath } from "./helpers/fixture-paths.js";

type Fixture = {
    event: string;
    payload: {
        event_type: string;
        payload: Record<string, unknown>;
    };
};

describe("opensea normalizer", () => {
    it("normalizes item_listed into a sell order", async () => {
        const fixture = await readFixture("item_listed.json");
        const normalized = normalizeOpenSeaEvent(fixture);
        expect(normalized).not.toBeNull();
        if (!normalized) return;

        expect(normalized.side).toBe("sell");
        expect(normalized.kind).toBe("seaport");
        expect(normalized.orderId).toBe(
            "0x27c086e5028d11931d7fa0bc47762dbf22d3cee845d2cc9191d7686f0a2bcc9b",
        );
        expect(normalized.maker).toBe(
            "0xcdbef8775bba8578b8c7e89071b9d2ee3c336296",
        );
        expect(normalized.contract).toBe(
            "0x5af0d9827e0c53e4799bb226655a1de152a425a5",
        );
        expect(normalized.tokenId).toBe("2522");
        expect(normalized.price).toBe("989199990000000000");
        expect(normalized.currency).toBe(
            "0x0000000000000000000000000000000000000000",
        );
    });

    it("normalizes item_received_bid into a buy order", async () => {
        const fixture = await readFixture("item_received_bid.json");
        const normalized = normalizeOpenSeaEvent(fixture);
        expect(normalized).not.toBeNull();
        if (!normalized) return;

        expect(normalized.side).toBe("buy");
        expect(normalized.kind).toBe("seaport");
        expect(normalized.orderId).toBe(
            "0xca2f030878888d975a62f94f5abcceda4b7b075e836eb112d1b9008ac0d22eaa",
        );
        expect(normalized.maker).toBe(
            "0xc19dc40f81aa9bfeda63f26ccd33aa465e7aa61a",
        );
        expect(normalized.contract).toBe(
            "0x5af0d9827e0c53e4799bb226655a1de152a425a5",
        );
        expect(normalized.tokenId).toBe("5788");
        expect(normalized.price).toBe("3310000000000000000");
        expect(normalized.currency).toBe(
            "0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2",
        );
    });

    it("normalizes item_received_offer into a buy order", async () => {
        const fixture = await readFixture("item_received_bid.json");
        const normalized = normalizeOpenSeaEvent({
            event_type: "item_received_offer",
            payload: fixture.payload,
        });
        expect(normalized).not.toBeNull();
        if (!normalized) return;

        expect(normalized.side).toBe("buy");
        expect(normalized.orderId).toBe(
            "0xca2f030878888d975a62f94f5abcceda4b7b075e836eb112d1b9008ac0d22eaa",
        );
    });

    it("prefers Seaport protocol data over wrapped OpenSea listing fields when both are present", async () => {
        const fixture = await readFixture("item_listed.json");
        const normalized = normalizeOpenSeaEvent({
            event_type: fixture.event_type,
            payload: {
                ...fixture.payload,
                item: {
                    nft_id: "ethereum/0x000000000000000000000000000000000000dEaD/999999",
                },
                base_price: "1",
                payment_token: {
                    address: "0x000000000000000000000000000000000000dEaD",
                },
                listing_date: "2000-01-01T00:00:00.000Z",
                expiration_date: "2000-01-02T00:00:00.000Z",
            },
        });
        expect(normalized).not.toBeNull();
        if (!normalized) return;

        expect(normalized.contract).toBe(
            "0x5af0d9827e0c53e4799bb226655a1de152a425a5",
        );
        expect(normalized.tokenId).toBe("2522");
        expect(normalized.price).toBe("989199990000000000");
        expect(normalized.currency).toBe(
            "0x0000000000000000000000000000000000000000",
        );
        expect(normalized.validFrom).toBe(1769383297);
        expect(normalized.validUntil).toBe(1769384197);
    });

    it("ignores unsupported event types", async () => {
        const fixture = await readFixture("item_sold.json");
        const normalized = normalizeOpenSeaEvent(fixture);
        expect(normalized).toBeNull();
    });

    it("normalizes collection_offer into a collection buy order", async () => {
        const fixture = await readFixture("collection_offer.json");
        const normalized = normalizeOpenSeaEvent(fixture);
        expect(normalized).not.toBeNull();
        if (!normalized) return;

        expect(normalized.side).toBe("buy");
        expect(normalized.kind).toBe("seaport");
        expect(normalized.contract).toBe(
            "0x8a90cab2b38dba80c64b7734e58ee1db38b8992e",
        );
        expect(normalized.tokenId).toBeNull();
        expect(normalized.sourceScopeKind).toBe("collection");
        expect(normalized.sourceSchema?.kind).toBe("collection");
    });

    it("normalizes trait_offer into an attribute token set (single trait)", async () => {
        const fixture = await readFixture("trait_offer-single_trait.json");
        const normalized = normalizeOpenSeaEvent(fixture);
        expect(normalized).not.toBeNull();
        if (!normalized) return;

        expect(normalized.side).toBe("buy");
        expect(normalized.kind).toBe("seaport");
        expect(normalized.tokenId).toBeNull();
        expect(normalized.sourceScopeKind).toBe("attribute");
        expect(normalized.sourceSchema?.kind).toBe("attribute");
        if (normalized.sourceSchema?.kind !== "attribute") return;
        expect(normalized.sourceSchema.data.attributes).toEqual([
            { key: "piercing", value: "airpod" },
        ]);
    });

    it("deduplicates trait_offer traits when both trait_criteria and trait_criteria_list contain the same pair", async () => {
        const fixture = await readFixture(
            "trait_offer-single_trait_w_list.json",
        );
        const normalized = normalizeOpenSeaEvent(fixture);
        expect(normalized).not.toBeNull();
        if (!normalized) return;

        expect(normalized.sourceScopeKind).toBe("attribute");
        expect(normalized.sourceSchema?.kind).toBe("attribute");
        if (normalized.sourceSchema?.kind !== "attribute") return;
        expect(normalized.sourceSchema.data.attributes).toEqual([
            { key: "Zone", value: "Xleph" },
        ]);
    });

    it("normalizes trait_offer into an attribute token set (multi trait)", async () => {
        const fixture = await readFixture("trait_offer-multi_trait.json");
        const normalized = normalizeOpenSeaEvent(fixture);
        expect(normalized).not.toBeNull();
        if (!normalized) return;

        expect(normalized.side).toBe("buy");
        expect(normalized.kind).toBe("seaport");
        expect(normalized.tokenId).toBeNull();
        expect(normalized.sourceScopeKind).toBe("attribute");
        expect(normalized.sourceSchema?.kind).toBe("attribute");
        if (normalized.sourceSchema?.kind !== "attribute") return;
        expect(normalized.sourceSchema.data.attributes).toEqual([
            { key: "Biome", value: "81" },
            { key: "Mode", value: "Terrain" },
        ]);
    });

    it("normalizes item_cancelled into an order update-by-id cancel", async () => {
        const fixture = await readFixture("item_cancelled.json");
        const normalized = normalizeOpenSeaOrderUpdate(fixture);
        expect(normalized).toEqual({
            orderId:
                "0xe7385bf786154848873d89e0b4e2e03406e396ee9d3cb4da47f801f719c0a792",
            reason: "cancel",
            sourceStatus: "cancelled",
        });
    });

    it("normalizes order_invalidation into an order update-by-id cancel", async () => {
        const fixture = await readFixture("order_invalidation.json");
        const normalized = normalizeOpenSeaOrderUpdate({
            event_type: "order_invalidation",
            payload: fixture,
        });
        expect(normalized).toEqual({
            orderId:
                "0xeed6698a43cbee5651b3cf0097e94c2b74db22afb8d3e9ea33770721907bfdef",
            reason: "cancel",
            sourceStatus: "invalidated",
        });
    });

    it("normalizes order_revalidation into an order update-by-id order", async () => {
        const fixture = await readFixture("order_revalidation.json");
        const normalized = normalizeOpenSeaOrderUpdate({
            event_type: "order_revalidation",
            payload: fixture,
        });
        expect(normalized).toEqual({
            orderId:
                "0xeed6698a43cbee5651b3cf0097e94c2b74db22afb8d3e9ea33770721907bfdef",
            reason: "order",
            sourceStatus: "active",
        });
    });

    it("normalizes order_invalidate into an order update-by-id cancel", async () => {
        const fixture = await readFixture("order_invalidation.json");
        const normalized = normalizeOpenSeaOrderUpdate({
            event_type: "order_invalidate",
            payload: fixture,
        });
        expect(normalized).toEqual({
            orderId:
                "0xeed6698a43cbee5651b3cf0097e94c2b74db22afb8d3e9ea33770721907bfdef",
            reason: "cancel",
            sourceStatus: "invalidated",
        });
    });

    it("normalizes order_revalidate into an order update-by-id order", async () => {
        const fixture = await readFixture("order_revalidation.json");
        const normalized = normalizeOpenSeaOrderUpdate({
            event_type: "order_revalidate",
            payload: fixture,
        });
        expect(normalized).toEqual({
            orderId:
                "0xeed6698a43cbee5651b3cf0097e94c2b74db22afb8d3e9ea33770721907bfdef",
            reason: "order",
            sourceStatus: "active",
        });
    });

    it("normalizes item_sold into a source filled update", async () => {
        const fixture = await readFixture("item_sold.json");
        const normalized = normalizeOpenSeaOrderUpdate(fixture);
        expect(normalized).toEqual({
            orderId:
                "0x1f8622e3ac13442daa31ce49c7a5e3ae6086f857a435017eb37aed4901cd7c96",
            reason: "fill",
            sourceStatus: "filled",
        });
    });

    it("normalizes item_transferred into a maker update", async () => {
        const fixture = await readFixture("item_transferred.json");
        const normalized = normalizeOpenSeaMakerUpdate(fixture.payload);
        expect(normalized).toEqual({
            maker: "0x0000000000000000000000000000000000000000",
            contract: "0x495f947276749ce646f68ac8c248420045cb7b5e",
            tokenId:
                "91577084333317265455693574180089203123053062749515767918158455086200710496257",
            reason: "item_transferred",
        });
    });

    it("normalizes item_sold into a maker update", async () => {
        const fixture = await readFixture("item_sold.json");
        const normalized = normalizeOpenSeaMakerUpdate(fixture);
        expect(normalized).toEqual({
            maker: "0x44d3376971080f0716ef1f498093521d412b8dec",
            contract: "0x5af0d9827e0c53e4799bb226655a1de152a425a5",
            tokenId: "832",
            reason: "item_sold",
        });
    });

    it("normalizes item_metadata_updated into a metadata refresh", async () => {
        const fixture = await readFixture("item_metadata_updated.json");
        const normalized = normalizeOpenSeaMetadataRefresh(fixture);
        expect(normalized).toEqual({
            contract: "0x8a90cab2b38dba80c64b7734e58ee1db38b8992e",
            tokenId: "222",
            metadataUrl:
                "https://opensea.mypinata.cloud/ipfs/QmPMc4tcBsMqLRuCQtPmPe84bpSjrC3Ky7t3JWuHXYB4aS/222",
            reason: "metadata_updated",
        });
    });
});

async function readFixture(file: string): Promise<Fixture> {
    const fixturePath = resolveFixturePath(
        import.meta.url,
        "opensea-event-payloads",
        file,
    );
    const raw = await fs.readFile(fixturePath, "utf8");
    return JSON.parse(raw) as Fixture;
}
