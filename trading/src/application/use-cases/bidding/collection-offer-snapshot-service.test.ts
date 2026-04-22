import { strict as assert } from "node:assert";
import { describe, it } from "vitest";
import { CollectionOfferSnapshotService } from "./collection-offer-snapshot-service.js";

class FakeCollectionOfferSource {
    public calls: string[] = [];
    public responses: Record<string, unknown[]> = {};
    public gate?: Promise<void>;

    async getAllOffers(collectionSlug: string): Promise<unknown[]> {
        this.calls.push(collectionSlug);
        if (this.gate) {
            await this.gate;
        }
        return this.responses[collectionSlug] ?? [];
    }
}

describe("CollectionOfferSnapshotService", () => {
    it("refreshes watched collections and stores snapshots", async () => {
        const source = new FakeCollectionOfferSource();
        source.responses.terraforms = [{ order_hash: "0x1" }];
        const service = new CollectionOfferSnapshotService(
            source as any,
            ["terraforms"],
            60000,
            0,
        );

        await service.refreshAndWait("terraforms", "test reason");

        const snapshot = service.getSnapshot("terraforms");
        assert.ok(snapshot);
        assert.equal(snapshot?.offers.length, 1);
        assert.deepEqual(source.calls, ["terraforms"]);
    });

    it("collapses refresh spam into a single pending rerun per collection", async () => {
        const source = new FakeCollectionOfferSource();
        let releaseGate!: () => void;
        source.gate = new Promise<void>((resolve) => {
            releaseGate = resolve;
        });
        source.responses.terraforms = [{ order_hash: "0x1" }];
        const service = new CollectionOfferSnapshotService(
            source as any,
            ["terraforms"],
            60000,
            0,
        );

        service.requestRefresh("terraforms", "first");
        service.requestRefresh("terraforms", "second");
        service.requestRefresh("terraforms", "third");

        await new Promise((resolve) => setTimeout(resolve, 10));
        releaseGate();
        await new Promise((resolve) => setTimeout(resolve, 20));

        assert.equal(source.calls.length, 2);
    });

    it("ignores refresh requests for unwatched collections", async () => {
        const source = new FakeCollectionOfferSource();
        const service = new CollectionOfferSnapshotService(
            source as any,
            ["terraforms"],
            60000,
            0,
        );

        service.requestRefresh("remilio-babies");
        await new Promise((resolve) => setTimeout(resolve, 10));

        assert.equal(source.calls.length, 0);
        assert.equal(service.getSnapshot("remilio-babies"), null);
    });

    it("skips event-triggered refresh when the snapshot is still within ttl", async () => {
        const source = new FakeCollectionOfferSource();
        source.responses.terraforms = [{ order_hash: "0x1" }];
        const service = new CollectionOfferSnapshotService(
            source as any,
            ["terraforms"],
            60000,
            1000,
        );

        await service.refreshAndWait("terraforms", "bootstrap");
        await service.refreshAndWait(
            "terraforms",
            "eventType=trait_offer, matchedTraits=Biome",
            { respectTtl: true },
        );

        assert.deepEqual(source.calls, ["terraforms"]);
    });
});
