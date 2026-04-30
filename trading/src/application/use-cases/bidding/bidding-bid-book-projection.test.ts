import { strict as assert } from "node:assert";
import { describe, it } from "vitest";
import {
    BiddingBidBookProjectionScheduler,
    type BiddingBidBookProjectionPort,
} from "./bidding-bid-book-projection.js";
import type { CollectionOfferSnapshot } from "./collection-offer-snapshot-service.js";

class FakeProjectionPort implements BiddingBidBookProjectionPort {
    public calls: Array<{ snapshot: CollectionOfferSnapshot; reason: string }> =
        [];
    public gate: Promise<void> | null = null;

    async replaceCollectionBidBook(
        snapshot: CollectionOfferSnapshot,
        reason: string,
    ) {
        this.calls.push({ snapshot, reason });
        if (this.gate) {
            await this.gate;
        }
        return {
            collectionSlug: snapshot.collectionSlug,
            rowCount: snapshot.offers.length,
            durationMs: 1,
        };
    }
}

describe("BiddingBidBookProjectionScheduler", () => {
    it("coalesces in-flight projection requests and reruns with the latest snapshot", async () => {
        const projection = new FakeProjectionPort();
        let releaseGate!: () => void;
        projection.gate = new Promise<void>((resolve) => {
            releaseGate = resolve;
        });
        const scheduler = new BiddingBidBookProjectionScheduler(
            projection,
            10,
        );

        scheduler.requestProjection(makeSnapshot("first"), "bootstrap");
        await sleep(0);
        scheduler.requestProjection(makeSnapshot("second"), "stream");
        scheduler.requestProjection(makeSnapshot("third"), "poll cadence");
        releaseGate();
        await sleep(30);
        scheduler.stop();

        assert.equal(projection.calls.length, 2);
        assert.deepEqual(
            projection.calls.map((call) => call.snapshot.offers[0]),
            ["first", "third"],
        );
        assert.equal(projection.calls[0]?.reason, "bootstrap");
        assert.equal(
            projection.calls[1]?.reason,
            "stream || poll cadence",
        );
    });
});

function makeSnapshot(label: string): CollectionOfferSnapshot {
    return {
        collectionSlug: "terraforms",
        offers: [label],
        refreshedAt: Date.now(),
    };
}

function sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
}
