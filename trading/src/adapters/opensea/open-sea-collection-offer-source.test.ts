import { strict as assert } from "node:assert";
import { describe, it } from "vitest";
import { CollectionOfferSourceError } from "../../application/use-cases/bidding/collection-offer-snapshot-service.js";
import { BIDDING_DEFAULT_OPEN_SEA_OFFERS_PAGE_SIZE } from "../../config/bidding-defaults.js";
import {
    OPEN_SEA_SNAPSHOT_OPERATION,
    OpenSeaCollectionOfferSource,
} from "./open-sea-collection-offer-source.js";

class FakeOpenSeaApiClient {
    public pages: Array<{ offers?: unknown[]; next?: string } | Error> = [];
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
        const page = this.pages.shift() ?? { offers: [] };
        if (page instanceof Error) {
            throw page;
        }
        return page;
    }
}

describe("OpenSeaCollectionOfferSource", () => {
    it("paginates all collection offers with the shared default page size until the cursor stops", async () => {
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

        const operations: string[] = [];
        const source = new OpenSeaCollectionOfferSource(api as any, {
            observability: {
                onOpenSeaOperationFinished: (input) =>
                    operations.push(input.operation),
                onOpenSeaRetry: () => undefined,
            },
        });

        const result = await source.getAllOffers("terraforms");

        assert.deepEqual(result.offers, [
            { order_hash: "0x1", price: { current: { value: "200" } } },
            { order_hash: "0x2", price: { current: { value: "100" } } },
        ]);
        assert.equal(result.metrics.pageCount, 2);
        assert.equal(result.metrics.offerCount, 2);
        assert.equal(result.metrics.complete, true);
        assert.equal(result.metrics.firstPriceWei, "200");
        assert.equal(result.metrics.lastPriceWei, "100");
        assert.equal(result.metrics.minPriceWei, "100");
        assert.equal(result.metrics.maxPriceWei, "200");
        assert.deepEqual(api.calls, [
            {
                collectionSlug: "terraforms",
                limit: BIDDING_DEFAULT_OPEN_SEA_OFFERS_PAGE_SIZE,
                next: undefined,
            },
            {
                collectionSlug: "terraforms",
                limit: BIDDING_DEFAULT_OPEN_SEA_OFFERS_PAGE_SIZE,
                next: "page-2",
            },
        ]);
        assert.deepEqual(operations, [
            OPEN_SEA_SNAPSHOT_OPERATION.GetAllOffersPage,
            OPEN_SEA_SNAPSHOT_OPERATION.GetAllOffersPage,
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
        assert.equal(result.metrics.complete, false);
        assert.equal(api.calls.length, 2);
    });

    it("preserves completed page and offer counts when a later page fails", async () => {
        const api = new FakeOpenSeaApiClient();
        api.pages = [
            { offers: [{ order_hash: "0x1" }], next: "page-2" },
            new Error("second page unavailable"),
        ];
        const source = new OpenSeaCollectionOfferSource(api as any, {
            offersPageSize: 50,
            retryPolicy: {
                maxAttempts: 1,
                baseDelayMs: 0,
                maxDelayMs: 0,
                jitterRatio: 0,
            },
        });

        await assert.rejects(
            () => source.getAllOffers("terraforms"),
            (error: unknown) => {
                assert.ok(error instanceof CollectionOfferSourceError);
                assert.equal(error.metrics.pageCount, 1);
                assert.equal(error.metrics.offerCount, 1);
                assert.equal(error.metrics.complete, false);
                assert.equal(error.metrics.finalCursor, "page-2");
                return true;
            },
        );
    });
});
