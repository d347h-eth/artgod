import { strict as assert } from "node:assert";
import { describe, it } from "vitest";
import {
    COLLECTION_OFFER_REFRESH_OUTCOME,
    COLLECTION_OFFER_SNAPSHOT_REFRESH_RESULT,
    CollectionOfferSourceError,
    CollectionOfferSnapshotService,
    createCollectionOfferSnapshotMetrics,
    type CollectionOfferRefreshOutcome,
    type CollectionOfferSourceResult,
    type CollectionOfferSnapshotObserver,
    type CollectionOfferSnapshotRefreshResult,
} from "./collection-offer-snapshot-service.js";

class FakeCollectionOfferSource {
    public calls: string[] = [];
    public responses: Record<string, unknown[]> = {};
    public durationMs = 1;
    public gate?: Promise<void>;
    public failure?: Error;
    public complete = true;

    async getAllOffers(
        collectionSlug: string,
    ): Promise<CollectionOfferSourceResult> {
        this.calls.push(collectionSlug);
        if (this.gate) {
            await this.gate;
        }
        if (this.failure) {
            throw this.failure;
        }
        return makeSourceResult(
            this.responses[collectionSlug] ?? [],
            this.durationMs,
            this.complete,
        );
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

    it("extends ttl from the last refresh duration within the configured max", async () => {
        const source = new FakeCollectionOfferSource();
        source.durationMs = 80;
        source.responses.terraforms = [{ order_hash: "0x1" }];
        const service = new CollectionOfferSnapshotService(
            source as any,
            ["terraforms"],
            60000,
            50,
            undefined,
            {
                maxTtlMs: 200,
                durationMultiplier: 2,
            },
        );

        await service.refreshAndWait("terraforms", "bootstrap");
        await service.refreshAndWait("terraforms", "poll cadence", {
            respectTtl: true,
        });

        assert.deepEqual(source.calls, ["terraforms"]);
    });

    it("caps adaptive ttl at the configured maximum", async () => {
        const source = new FakeCollectionOfferSource();
        source.durationMs = 1_000;
        source.responses.terraforms = [{ order_hash: "0x1" }];
        const service = new CollectionOfferSnapshotService(
            source as any,
            ["terraforms"],
            60000,
            50,
            undefined,
            {
                maxTtlMs: 50,
                durationMultiplier: 2,
            },
        );

        await service.refreshAndWait("terraforms", "bootstrap");
        await new Promise((resolve) => setTimeout(resolve, 60));
        await service.refreshAndWait("terraforms", "poll cadence", {
            respectTtl: true,
        });

        assert.deepEqual(source.calls, ["terraforms", "terraforms"]);
    });

    it("backs off failed ttl-aware refreshes while allowing forced refreshes", async () => {
        const source = new FakeCollectionOfferSource();
        source.failure = new Error("OpenSea unavailable");
        const results: CollectionOfferSnapshotRefreshResult[] = [];
        const service = new CollectionOfferSnapshotService(
            source as any,
            ["terraforms"],
            60000,
            50,
            {
                onSnapshotRefreshFinished: (input) =>
                    results.push(input.result),
            },
            {
                maxTtlMs: 200,
            },
        );

        await assert.rejects(
            () =>
                service.refreshAndWait("terraforms", "poll cadence", {
                    respectTtl: true,
                }),
            /OpenSea unavailable/,
        );
        await service.refreshAndWait("terraforms", "poll cadence", {
            respectTtl: true,
        });

        source.failure = undefined;
        source.responses.terraforms = [{ order_hash: "0x1" }];
        await service.refreshAndWait("terraforms", "command", {
            respectTtl: false,
        });

        assert.deepEqual(source.calls, ["terraforms", "terraforms"]);
        assert.equal(service.getSnapshot("terraforms")?.offers.length, 1);
        assert.deepEqual(results, [
            COLLECTION_OFFER_SNAPSHOT_REFRESH_RESULT.Error,
            COLLECTION_OFFER_SNAPSHOT_REFRESH_RESULT.Complete,
        ]);
    });

    it("reports completed source work when a later snapshot page fails", async () => {
        const source = new FakeCollectionOfferSource();
        source.failure = new CollectionOfferSourceError(
            "later page unavailable",
            createCollectionOfferSnapshotMetrics({
                durationMs: 250,
                pageCount: 3,
                offerCount: 120,
                complete: false,
            }),
            new Error("later page unavailable"),
        );
        const finished: Array<{
            durationMs: number;
            pageCount: number;
            offerCount: number;
            result: CollectionOfferSnapshotRefreshResult;
        }> = [];
        const service = new CollectionOfferSnapshotService(
            source as any,
            ["terraforms"],
            60_000,
            0,
            {
                onSnapshotRefreshFinished: (input) => finished.push(input),
            },
        );

        await assert.rejects(
            () => service.refreshAndWait("terraforms", "test failure"),
            /later page unavailable/,
        );

        assert.deepEqual(finished, [
            {
                durationMs: 250,
                pageCount: 3,
                offerCount: 120,
                result: COLLECTION_OFFER_SNAPSHOT_REFRESH_RESULT.Error,
            },
        ]);
    });

    it("collapses refresh spam into a single pending rerun per collection", async () => {
        const source = new FakeCollectionOfferSource();
        let releaseGate!: () => void;
        source.gate = new Promise<void>((resolve) => {
            releaseGate = resolve;
        });
        source.responses.terraforms = [{ order_hash: "0x1" }];
        const outcomes: CollectionOfferRefreshOutcome[] = [];
        const states: Array<{
            inFlightRefreshes: number;
            pendingRefreshes: number;
        }> = [];
        const finished: CollectionOfferSnapshotRefreshResult[] = [];
        const observer: CollectionOfferSnapshotObserver = {
            onSnapshotRefreshRequest: (input) => outcomes.push(input.outcome),
            onSnapshotRefreshFinished: (input) => finished.push(input.result),
            onSnapshotStateChanged: (input) => states.push(input),
        };
        const service = new CollectionOfferSnapshotService(
            source as any,
            ["terraforms"],
            60000,
            0,
            observer,
        );

        const refreshes = [
            service.refreshAndWait("terraforms", "first"),
            service.refreshAndWait("terraforms", "second"),
            service.refreshAndWait("terraforms", "third"),
        ];

        await new Promise((resolve) => setTimeout(resolve, 10));
        releaseGate();
        await Promise.all(refreshes);

        assert.equal(source.calls.length, 2);
        assert.deepEqual(outcomes, [
            COLLECTION_OFFER_REFRESH_OUTCOME.Started,
            COLLECTION_OFFER_REFRESH_OUTCOME.Coalesced,
            COLLECTION_OFFER_REFRESH_OUTCOME.Coalesced,
        ]);
        assert.deepEqual(finished, [
            COLLECTION_OFFER_SNAPSHOT_REFRESH_RESULT.Complete,
            COLLECTION_OFFER_SNAPSHOT_REFRESH_RESULT.Complete,
        ]);
        assert.ok(
            states.some(
                (state) =>
                    state.inFlightRefreshes === 1 &&
                    state.pendingRefreshes === 1,
            ),
        );
        assert.deepEqual(states.at(-1), {
            watchedCollections: 1,
            inFlightRefreshes: 0,
            pendingRefreshes: 0,
        });
    });

    it("reports bootstrap collection start before long refresh completes", async () => {
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
        const started: Array<{
            collectionSlug: string;
            completed: number;
            total: number;
        }> = [];
        const completed: Array<{
            collectionSlug: string;
            completed: number;
            total: number;
        }> = [];

        const bootstrap = service.bootstrap({
            onCollectionStarted: (progress) => {
                started.push(progress);
            },
            onProgress: (progress) => {
                completed.push(progress);
            },
        });

        await new Promise((resolve) => setTimeout(resolve, 0));
        assert.deepEqual(started, [
            {
                collectionSlug: "terraforms",
                completed: 0,
                total: 1,
            },
        ]);
        assert.deepEqual(completed, []);

        releaseGate();
        await bootstrap;

        assert.deepEqual(completed, [
            {
                collectionSlug: "terraforms",
                completed: 1,
                total: 1,
            },
        ]);
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

    it("reconciles watched collections against the enabled snapshot-backed job set", async () => {
        const source = new FakeCollectionOfferSource();
        source.responses.milady = [{ order_hash: "0x1" }];
        source.responses.yumemono = [{ order_hash: "0x2" }];
        const service = new CollectionOfferSnapshotService(
            source as any,
            ["terraforms", "milady"],
            60000,
            0,
        );

        const result = service.reconcileWatchedCollections([
            "milady",
            "yumemono",
        ]);
        await service.refreshAndWait("terraforms", "removed");
        await service.refreshAndWait("milady", "kept");
        await service.refreshAndWait("yumemono", "added");

        assert.deepEqual(result, { added: 1, removed: 1 });
        assert.deepEqual(source.calls, ["milady", "yumemono"]);
    });

    it("does not await snapshot observers after replacing the authoritative snapshot", async () => {
        const source = new FakeCollectionOfferSource();
        source.responses.terraforms = [{ order_hash: "0x1" }];
        let observerStarted = false;
        let releaseObserver!: () => void;
        const observer = {
            onSnapshotRefreshed() {
                observerStarted = true;
                return new Promise<void>((resolve) => {
                    releaseObserver = resolve;
                });
            },
        };
        const service = new CollectionOfferSnapshotService(
            source as any,
            ["terraforms"],
            60000,
            0,
            observer as any,
        );

        await service.refreshAndWait("terraforms", "test");

        assert.equal(observerStarted, true);
        assert.equal(source.calls.length, 1);
        releaseObserver();
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

    it("skips async refresh requests when the snapshot is still within ttl", async () => {
        const source = new FakeCollectionOfferSource();
        source.responses.terraforms = [{ order_hash: "0x1" }];
        const service = new CollectionOfferSnapshotService(
            source as any,
            ["terraforms"],
            60000,
            1000,
        );

        await service.refreshAndWait("terraforms", "bootstrap");
        service.requestRefresh("terraforms", "poll cadence");
        await new Promise((resolve) => setTimeout(resolve, 10));

        assert.deepEqual(source.calls, ["terraforms"]);
    });

    it("waits for in-flight ttl-aware refresh before skipping duplicate work", async () => {
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
            1000,
        );

        const firstRefresh = service.refreshAndWait("terraforms", "command");
        await new Promise((resolve) => setTimeout(resolve, 0));
        const duplicateRefresh = service.refreshAndWait(
            "terraforms",
            "poll cadence",
            { respectTtl: true },
        );

        releaseGate();
        await Promise.all([firstRefresh, duplicateRefresh]);

        assert.deepEqual(source.calls, ["terraforms"]);
    });

    it("rejects partial results without replacing, projecting, or refreshing the authoritative snapshot", async () => {
        const source = new FakeCollectionOfferSource();
        source.responses.terraforms = [{ order_hash: "complete" }];
        const refreshOutcomes: CollectionOfferRefreshOutcome[] = [];
        const refreshResults: CollectionOfferSnapshotRefreshResult[] = [];
        const projectedOffers: unknown[][] = [];
        const observer: CollectionOfferSnapshotObserver = {
            onSnapshotRefreshed: (snapshot) => {
                projectedOffers.push(snapshot.offers);
            },
            onSnapshotRefreshRequest: (input) => {
                refreshOutcomes.push(input.outcome);
            },
            onSnapshotRefreshFinished: (input) => {
                refreshResults.push(input.result);
            },
        };
        const service = new CollectionOfferSnapshotService(
            source as any,
            ["terraforms"],
            60_000,
            10_000,
            observer,
        );

        await service.refreshAndWait("terraforms", "complete refresh");
        const completeSnapshot = service.getSnapshot("terraforms");
        assert.ok(completeSnapshot);
        completeSnapshot.refreshedAt = Date.now() - 20_000;

        source.complete = false;
        source.responses.terraforms = [{ order_hash: "partial" }];
        await assert.rejects(
            () => service.refreshAndWait("terraforms", "partial refresh"),
            /partial collection offer snapshot/,
        );
        await service.refreshAndWait("terraforms", "ttl refresh", {
            respectTtl: true,
        });

        assert.equal(service.getSnapshot("terraforms"), completeSnapshot);
        assert.deepEqual(projectedOffers, [[{ order_hash: "complete" }]]);
        assert.deepEqual(refreshResults, [
            COLLECTION_OFFER_SNAPSHOT_REFRESH_RESULT.Complete,
            COLLECTION_OFFER_SNAPSHOT_REFRESH_RESULT.Partial,
        ]);
        assert.deepEqual(refreshOutcomes, [
            COLLECTION_OFFER_REFRESH_OUTCOME.Started,
            COLLECTION_OFFER_REFRESH_OUTCOME.Started,
            COLLECTION_OFFER_REFRESH_OUTCOME.BackoffSkipped,
        ]);
        assert.deepEqual(source.calls, ["terraforms", "terraforms"]);
    });

    it("stops refresh admission, clears pending reruns, and waits for active source calls to settle", async () => {
        const source = new FakeCollectionOfferSource();
        let releaseSource!: () => void;
        source.gate = new Promise<void>((resolve) => {
            releaseSource = resolve;
        });
        const outcomes: CollectionOfferRefreshOutcome[] = [];
        const states: Array<{
            inFlightRefreshes: number;
            pendingRefreshes: number;
        }> = [];
        const service = new CollectionOfferSnapshotService(
            source as any,
            ["terraforms"],
            60_000,
            0,
            {
                onSnapshotRefreshRequest: (input) =>
                    outcomes.push(input.outcome),
                onSnapshotStateChanged: (input) => states.push(input),
            },
        );

        const activeRefresh = service.refreshAndWait("terraforms", "active");
        const pendingRefresh = service.refreshAndWait("terraforms", "pending");
        const joinedRefresh = service.refreshAndWait(
            "terraforms",
            "ttl-aware join",
            { respectTtl: true },
        );
        await new Promise((resolve) => setTimeout(resolve, 0));

        let drained = false;
        const drain = service.stop().then(() => {
            drained = true;
        });
        service.requestRefresh("terraforms", "after stop");
        await service.refreshAndWait("terraforms", "after stop");
        await new Promise((resolve) => setTimeout(resolve, 0));

        assert.equal(drained, false);
        assert.deepEqual(states.at(-1), {
            watchedCollections: 1,
            inFlightRefreshes: 1,
            pendingRefreshes: 0,
        });

        releaseSource();
        await Promise.all([
            activeRefresh,
            pendingRefresh,
            joinedRefresh,
            drain,
        ]);

        assert.equal(drained, true);
        assert.deepEqual(source.calls, ["terraforms"]);
        assert.deepEqual(outcomes, [
            COLLECTION_OFFER_REFRESH_OUTCOME.Started,
            COLLECTION_OFFER_REFRESH_OUTCOME.Coalesced,
            COLLECTION_OFFER_REFRESH_OUTCOME.JoinedInFlight,
            COLLECTION_OFFER_REFRESH_OUTCOME.Stopped,
            COLLECTION_OFFER_REFRESH_OUTCOME.Stopped,
            COLLECTION_OFFER_REFRESH_OUTCOME.Stopped,
        ]);
        assert.deepEqual(states.at(-1), {
            watchedCollections: 1,
            inFlightRefreshes: 0,
            pendingRefreshes: 0,
        });
    });
});

function makeSourceResult(
    offers: unknown[],
    durationMs: number,
    complete = true,
): CollectionOfferSourceResult {
    return {
        offers,
        metrics: createCollectionOfferSnapshotMetrics({
            durationMs,
            pageCount: 1,
            offerCount: offers.length,
            complete,
        }),
    };
}
