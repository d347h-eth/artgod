import { strict as assert } from "node:assert";
import { describe, it } from "vitest";
import { OpenSeaCollectionOfferSource } from "./open-sea-collection-offer-source.js";

class FakeOpenSeaApiClient {
    public pages: Array<{ offers?: unknown[]; next?: string }> = [];
    public calls: Array<{
        collectionSlug: string;
        limit?: number;
        next?: string;
    }> = [];

    async getAllOffers(
        collectionSlug: string,
        limit?: number,
        next?: string,
    ): Promise<{ offers?: unknown[]; next?: string }> {
        this.calls.push({ collectionSlug, limit, next });
        return this.pages.shift() ?? { offers: [] };
    }
}

describe("OpenSeaCollectionOfferSource", () => {
    it("paginates all collection offers until the cursor stops", async () => {
        const api = new FakeOpenSeaApiClient();
        api.pages = [
            {
                offers: [
                    {
                        order_hash: "0x1",
                        price: { current: { value: "200" } },
                    },
                ],
                next: "page-2",
            },
            {
                offers: [
                    {
                        order_hash: "0x2",
                        price: { current: { value: "100" } },
                    },
                ],
            },
        ];

        const source = new OpenSeaCollectionOfferSource(api as any, {
            offersPageSize: 100,
        });

        const result = await source.getAllOffers("terraforms");

        assert.deepEqual(result.offers, [
            { order_hash: "0x1", price: { current: { value: "200" } } },
            { order_hash: "0x2", price: { current: { value: "100" } } },
        ]);
        assert.equal(result.metrics.pageCount, 2);
        assert.equal(result.metrics.offerCount, 2);
        assert.equal(result.metrics.firstPriceWei, "200");
        assert.equal(result.metrics.lastPriceWei, "100");
        assert.equal(result.metrics.minPriceWei, "100");
        assert.equal(result.metrics.maxPriceWei, "200");
        assert.deepEqual(api.calls, [
            {
                collectionSlug: "terraforms",
                limit: 100,
                next: undefined,
            },
            {
                collectionSlug: "terraforms",
                limit: 100,
                next: "page-2",
            },
        ]);
    });

    it("stops when the API repeats a cursor to avoid pagination loops", async () => {
        const api = new FakeOpenSeaApiClient();
        api.pages = [
            { offers: [{ order_hash: "0x1" }], next: "page-2" },
            { offers: [{ order_hash: "0x2" }], next: "page-2" },
            { offers: [{ order_hash: "0x3" }], next: "page-3" },
        ];

        const source = new OpenSeaCollectionOfferSource(api as any, {
            offersPageSize: 50,
        });

        const result = await source.getAllOffers("terraforms");

        assert.deepEqual(result.offers, [
            { order_hash: "0x1" },
            { order_hash: "0x2" },
        ]);
        assert.equal(result.metrics.pageCount, 2);
        assert.equal(result.metrics.offerCount, 2);
        assert.equal(result.metrics.finalCursor, "page-2");
        assert.equal(api.calls.length, 2);
    });
});
