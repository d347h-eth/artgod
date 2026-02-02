import { describe, expect, it } from "vitest";
import fs from "node:fs/promises";
import path from "node:path";
import { normalizeOpenSeaEvent } from "../src/application/offchain/opensea-normalize.js";

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
        expect(normalized.tokenSetSchema?.kind).toBe("collection");
    });

    it("normalizes trait_offer into an attribute token set (single trait)", async () => {
        const fixture = await readFixture("trait_offer-single_trait.json");
        const normalized = normalizeOpenSeaEvent(fixture);
        expect(normalized).not.toBeNull();
        if (!normalized) return;

        expect(normalized.side).toBe("buy");
        expect(normalized.kind).toBe("seaport");
        expect(normalized.tokenId).toBeNull();
        expect(normalized.tokenSetSchema?.kind).toBe("attribute");
        if (normalized.tokenSetSchema?.kind !== "attribute") return;
        expect(normalized.tokenSetSchema.data.attributes).toEqual([
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

        expect(normalized.tokenSetSchema?.kind).toBe("attribute");
        if (normalized.tokenSetSchema?.kind !== "attribute") return;
        expect(normalized.tokenSetSchema.data.attributes).toEqual([
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
        expect(normalized.tokenSetSchema?.kind).toBe("attribute");
        if (normalized.tokenSetSchema?.kind !== "attribute") return;
        expect(normalized.tokenSetSchema.data.attributes).toEqual([
            { key: "Biome", value: "81" },
            { key: "Mode", value: "Terrain" },
        ]);
    });
});

async function readFixture(file: string): Promise<Fixture> {
    const fixturePath = path.resolve(
        process.cwd(),
        "tests/fixtures/opensea-event-payloads",
        file,
    );
    const raw = await fs.readFile(fixturePath, "utf8");
    return JSON.parse(raw) as Fixture;
}
