import { strict as assert } from "node:assert";
import { describe, it } from "vitest";
import {
    BIDDING_BID_BOOK_PROJECTION_OUTCOME,
    BIDDING_BID_BOOK_PROJECTION_REQUEST_OUTCOME,
    BiddingBidBookProjectionScheduler,
    type BiddingBidBookProjectionObservabilityPort,
    type BiddingBidBookProjectionErrorInput,
    type BiddingBidBookProjectionPort,
    type BiddingBidBookProjectionResult,
    type BiddingBidBookProjectionOutcome,
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
    public outcome: BiddingBidBookProjectionResult["outcome"] =
        BIDDING_BID_BOOK_PROJECTION_OUTCOME.Published;

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
            outcome: this.outcome,
            collectionSlug: snapshot.collectionSlug,
            rowCount:
                this.outcome === BIDDING_BID_BOOK_PROJECTION_OUTCOME.Published
                    ? snapshot.offers.length
                    : 0,
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
    it("retains previous publication freshness and lag after a skipped write", async () => {
        const projection = new FakeProjectionPort();
        const finished: BiddingBidBookProjectionOutcome[] = [];
        const workSucceeded: boolean[] = [];
        const scheduler = new BiddingBidBookProjectionScheduler(
            projection,
            0,
            {
                onWorkStarted: () => (succeeded) =>
                    workSucceeded.push(succeeded),
                onProjectionRequested: () => undefined,
                onProjectionFinished: ({ outcome }) => finished.push(outcome),
                onProjectionStateChanged: () => undefined,
            },
            ["terraforms"],
        );
        scheduler.requestProjection(
            { ...makeSnapshot("first"), refreshedAt: 1000 },
            "initial",
        );
        await sleep(0);
        const previous = scheduler.readPublicationHealth();

        projection.outcome = BIDDING_BID_BOOK_PROJECTION_OUTCOME.Skipped;
        scheduler.requestProjection(
            { ...makeSnapshot("skipped"), refreshedAt: 2000 },
            "collection missing",
        );
        await sleep(0);
        await scheduler.stop();

        assert.deepEqual(scheduler.readPublicationHealth(), {
            ...previous,
            laggingCollections: 1,
        });
        assert.deepEqual(finished, [
            BIDDING_BID_BOOK_PROJECTION_OUTCOME.Published,
            BIDDING_BID_BOOK_PROJECTION_OUTCOME.Skipped,
        ]);
        assert.deepEqual(workSucceeded, [true, false]);
        assert.deepEqual(projection.errors, []);
    });

    it("runs a coalesced successor after a skipped publication", async () => {
        const projection = new FakeProjectionPort();
        projection.outcome = BIDDING_BID_BOOK_PROJECTION_OUTCOME.Skipped;
        let releaseGate!: () => void;
        projection.gate = new Promise<void>((resolve) => {
            releaseGate = resolve;
        });
        const finished: BiddingBidBookProjectionOutcome[] = [];
        const lagAfterCompletion: number[] = [];
        let finishSuccessor!: () => void;
        const successorFinished = new Promise<void>((resolve) => {
            finishSuccessor = resolve;
        });
        const scheduler = new BiddingBidBookProjectionScheduler(
            projection,
            10,
            {
                onProjectionRequested: () => undefined,
                onProjectionFinished: ({ outcome }) => {
                    finished.push(outcome);
                    lagAfterCompletion.push(
                        scheduler.readPublicationHealth().laggingCollections,
                    );
                    projection.outcome =
                        BIDDING_BID_BOOK_PROJECTION_OUTCOME.Published;
                    if (finished.length === 2) finishSuccessor();
                },
                onProjectionStateChanged: () => undefined,
            },
            ["terraforms"],
        );
        scheduler.requestProjection(makeSnapshot("skipped"), "initial");
        await sleep(0);
        scheduler.requestProjection(makeSnapshot("successor"), "coalesced");
        releaseGate();
        await successorFinished;
        await scheduler.stop();

        assert.deepEqual(
            projection.calls.map((call) => call.snapshot.offers[0]),
            ["skipped", "successor"],
        );
        assert.deepEqual(finished, [
            BIDDING_BID_BOOK_PROJECTION_OUTCOME.Skipped,
            BIDDING_BID_BOOK_PROJECTION_OUTCOME.Published,
        ]);
        assert.deepEqual(lagAfterCompletion, [1, 0]);
        assert.equal(scheduler.readPublicationHealth().missingCollections, 0);
    });

    it("retains publication lag when different snapshots have identical timestamps", async () => {
        const projection = new FakeProjectionPort();
        const scheduler = new BiddingBidBookProjectionScheduler(
            projection,
            0,
            undefined,
            ["terraforms"],
        );
        scheduler.requestProjection(
            { ...makeSnapshot("first"), refreshedAt: 1000 },
            "first",
        );
        await sleep(0);
        projection.failure = new Error("synthetic write failure");
        scheduler.requestProjection(
            { ...makeSnapshot("different"), refreshedAt: 1000 },
            "same timestamp",
        );
        await sleep(0);
        assert.equal(scheduler.readPublicationHealth().laggingCollections, 1);
        projection.failure = null;
        scheduler.requestProjection(
            { ...makeSnapshot("retry"), refreshedAt: 1000 },
            "retry",
        );
        await sleep(0);
        assert.equal(scheduler.readPublicationHealth().laggingCollections, 0);
        await scheduler.stop();
    });

    it("keeps publication freshness distinct from fetched data across failed writes and unwatching", async () => {
        const projection = new FakeProjectionPort();
        const scheduler = new BiddingBidBookProjectionScheduler(
            projection,
            0,
            undefined,
            ["terraforms", "missing"],
        );
        scheduler.requestProjection(
            { ...makeSnapshot("first"), refreshedAt: 1000 },
            "first",
        );
        await sleep(0);
        assert.equal(scheduler.readPublicationHealth().missingCollections, 1);
        assert.equal(
            scheduler.readPublicationHealth().oldestPublishedSnapshotAtMs,
            1000,
        );
        const publishedAt =
            scheduler.readPublicationHealth().oldestPublishedAtMs;
        projection.failure = new Error("synthetic write failure");
        scheduler.requestProjection(
            { ...makeSnapshot("second"), refreshedAt: 2000 },
            "second",
        );
        await sleep(0);
        assert.equal(scheduler.readPublicationHealth().laggingCollections, 1);
        assert.equal(
            scheduler.readPublicationHealth().oldestPublishedAtMs,
            publishedAt,
        );
        assert.equal(
            scheduler.readPublicationHealth().oldestPublishedSnapshotAtMs,
            1000,
        );
        projection.failure = null;
        scheduler.requestProjection(
            { ...makeSnapshot("third"), refreshedAt: 3000 },
            "third",
        );
        await sleep(0);
        assert.equal(scheduler.readPublicationHealth().laggingCollections, 0);
        assert.equal(
            scheduler.readPublicationHealth().oldestPublishedSnapshotAtMs,
            3000,
        );
        scheduler.reconcileWatchedCollections([]);
        assert.deepEqual(scheduler.readPublicationHealth(), {
            watchedCollections: 0,
            missingCollections: 0,
            laggingCollections: 0,
            oldestPublishedAtMs: null,
            oldestPublishedSnapshotAtMs: null,
        });
        await scheduler.stop();
    });

    it("coalesces in-flight projection requests and reruns with the latest snapshot", async () => {
        const projection = new FakeProjectionPort();
        let releaseGate!: () => void;
        projection.gate = new Promise<void>((resolve) => {
            releaseGate = resolve;
        });
        const requests: string[] = [];
        const finished: BiddingBidBookProjectionOutcome[] = [];
        const lagAfterCompletion: number[] = [];
        const states: Array<{ active: number; pending: number }> = [];
        const observability: BiddingBidBookProjectionObservabilityPort = {
            onProjectionRequested: (input) => requests.push(input.outcome),
            onProjectionFinished: (input) => {
                finished.push(input.outcome);
                lagAfterCompletion.push(
                    scheduler.readPublicationHealth().laggingCollections,
                );
            },
            onProjectionStateChanged: (input) => states.push(input),
        };
        const scheduler = new BiddingBidBookProjectionScheduler(
            projection,
            10,
            observability,
            ["terraforms"],
        );

        scheduler.requestProjection(makeSnapshot("first"), "bootstrap");
        await sleep(0);
        scheduler.requestProjection(makeSnapshot("second"), "stream");
        scheduler.requestProjection(makeSnapshot("third"), "poll cadence");
        releaseGate();
        await sleep(30);
        await scheduler.stop();

        assert.equal(projection.calls.length, 2);
        assert.deepEqual(
            projection.calls.map((call) => call.snapshot.offers[0]),
            ["first", "third"],
        );
        assert.equal(projection.calls[0]?.reason, "bootstrap");
        assert.equal(projection.calls[1]?.reason, "stream || poll cadence");
        assert.deepEqual(requests, [
            BIDDING_BID_BOOK_PROJECTION_REQUEST_OUTCOME.Started,
            BIDDING_BID_BOOK_PROJECTION_REQUEST_OUTCOME.Coalesced,
            BIDDING_BID_BOOK_PROJECTION_REQUEST_OUTCOME.Coalesced,
        ]);
        assert.deepEqual(finished, [
            BIDDING_BID_BOOK_PROJECTION_OUTCOME.Published,
            BIDDING_BID_BOOK_PROJECTION_OUTCOME.Published,
        ]);
        // Finishing an older write must not clear lag for the newer coalesced snapshot.
        assert.deepEqual(lagAfterCompletion, [1, 0]);
        assert.ok(states.some((state) => state.active === 1));
        assert.ok(states.some((state) => state.pending === 1));
    });

    it("records projection failures through the projection port", async () => {
        const projection = new FakeProjectionPort();
        projection.failure = new Error("projection exploded");
        const scheduler = new BiddingBidBookProjectionScheduler(projection, 10);

        scheduler.requestProjection(makeSnapshot("first"), "poll cadence");
        await sleep(10);
        await scheduler.stop();

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

    it("waits for an active projection write during stop", async () => {
        const projection = new FakeProjectionPort();
        let releaseGate!: () => void;
        projection.gate = new Promise<void>((resolve) => {
            releaseGate = resolve;
        });
        const scheduler = new BiddingBidBookProjectionScheduler(projection, 10);
        scheduler.requestProjection(makeSnapshot("first"), "bootstrap");
        await sleep(0);

        let stopped = false;
        const stop = scheduler.stop().then(() => {
            stopped = true;
        });
        await Promise.resolve();

        assert.equal(stopped, false);
        releaseGate();
        await stop;
        assert.equal(stopped, true);
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
