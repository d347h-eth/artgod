import { strict as assert } from "node:assert";
import { describe, it } from "vitest";
import {
    BiddingBidBookProjectionScheduler,
    type BiddingBidBookProjectionErrorInput,
    type BiddingBidBookProjectionPort,
} from "./bidding-bid-book-projection.js";
import {
    createCollectionOfferSnapshotMetrics,
    type CollectionOfferSnapshot,
} from "./collection-offer-snapshot-service.js";

class FakeProjectionPort implements BiddingBidBookProjectionPort {
    public calls: Array<{ snapshot: CollectionOfferSnapshot; reason: string }> =
        [];
    public errors: BiddingBidBookProjectionErrorInput[] = [];
    public gate: Promise<void> | null = null;
    public failure: Error | null = null;

    async replaceCollectionBidBook(
        snapshot: CollectionOfferSnapshot,
        reason: string,
    ) {
        this.calls.push({ snapshot, reason });
        if (this.gate) {
            await this.gate;
        }
        if (this.failure) {
            throw this.failure;
        }
        return {
            collectionSlug: snapshot.collectionSlug,
            rowCount: snapshot.offers.length,
            durationMs: 1,
        };
    }

    async recordCollectionBidBookError(
        input: BiddingBidBookProjectionErrorInput,
    ): Promise<void> {
        this.errors.push(input);
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

    it("records projection failures through the projection port", async () => {
        const projection = new FakeProjectionPort();
        projection.failure = new Error("projection exploded");
        const scheduler = new BiddingBidBookProjectionScheduler(projection, 10);

        scheduler.requestProjection(makeSnapshot("first"), "poll cadence");
        await sleep(10);
        scheduler.stop();

        assert.equal(projection.calls.length, 1);
        assert.equal(projection.errors.length, 1);
        assert.equal(
            projection.errors[0]?.snapshot.collectionSlug,
            "terraforms",
        );
        assert.equal(projection.errors[0]?.reason, "poll cadence");
        assert.equal(projection.errors[0]?.errorMessage, "projection exploded");
        assert.ok((projection.errors[0]?.durationMs ?? -1) >= 0);
    });
});

function makeSnapshot(label: string): CollectionOfferSnapshot {
    return {
        collectionSlug: "terraforms",
        offers: [label],
        refreshedAt: Date.now(),
        metrics: createCollectionOfferSnapshotMetrics({ offerCount: 1 }),
    };
}

function sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
}
