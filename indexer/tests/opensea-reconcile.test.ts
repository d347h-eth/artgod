import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { db, setDbPath } from "@artgod/shared/database";
import { createMigrationRunner } from "@artgod/shared/migrations";
import {
    COLLECTION_STATUS,
    OPENSEA_COLLECTION_STATUS,
} from "@artgod/shared/types";
import { logger } from "@artgod/shared/utils";
import {
    handleReconcileJob,
    scheduleDueReconciles,
} from "../src/application/offchain/opensea-reconcile.js";
import { OpenSeaOrderbookSync } from "../src/application/offchain/opensea-orderbook-sync.js";
import { OpenSeaReconcilePolicy } from "../src/domain/opensea-reconcile-policy.js";
import {
    OPENSEA_JOB_KIND,
    OPENSEA_JOB_ID_SCOPE,
    OPENSEA_QUEUE_NAME,
    OPENSEA_RECONCILE_REASON as REASON,
    type OpenSeaReconcileReason,
    type OpenSeaReconcileCollectionPayload,
} from "../src/domain/opensea-jobs.js";
import type { JobEnvelope } from "../src/domain/jobs.js";
import { SqliteCollectionRegistry } from "../src/infra/collections/sqlite.js";
import { SqliteOpenSeaOrderbookRuns } from "../src/infra/offchain/sqlite-orderbook-runs.js";
import { SqliteOrderSourceStateStore } from "../src/infra/offchain/sqlite-order-source-state.js";
import { OFFCHAIN_ORDER_SOURCE } from "../src/domain/offchain-jobs.js";
import { ORDER_SOURCE_STATUS, ORDER_STATUS } from "../src/domain/orders.js";
import { createTempDbPath } from "./helpers/test-helpers.js";
import { loadTestEnv } from "./helpers/test-env.js";
import { loadOpenSeaConfig } from "../src/config/opensea.js";

describe("OpenSea reconciliation admission", () => {
    loadTestEnv();
    const thresholds = loadOpenSeaConfig().opensea;
    const freshness = new OpenSeaReconcilePolicy(thresholds);
    let collections: SqliteCollectionRegistry;
    let runs: SqliteOpenSeaOrderbookRuns;
    const queue = { publish: vi.fn() };
    const sync = { syncCollection: vi.fn() };
    beforeEach(async () => {
        vi.clearAllMocks();
        sync.syncCollection
            .mockReset()
            .mockResolvedValue({ activeOrders: 0, deactivatedOrders: 0 });
        queue.publish.mockReset().mockResolvedValue(undefined);
        vi.spyOn(logger, "info").mockImplementation(() => {});
        vi.spyOn(logger, "debug").mockImplementation(() => {});
        vi.spyOn(logger, "warn").mockImplementation(() => {});
        setDbPath(await createTempDbPath());
        await createMigrationRunner().runMigrations();
        collections = new SqliteCollectionRegistry();
        runs = new SqliteOpenSeaOrderbookRuns();
        seed(99);
    });
    afterEach(() => {
        db.raw.close();
        vi.restoreAllMocks();
    });

    function seed(id: number) {
        db.prepare(
            `INSERT INTO collections
            (collection_id,chain_id,slug,address,standard,status,token_scope_kind,opensea_slug,opensea_status)
            VALUES (?,1,?,?,'erc721',?,'contract_all_tokens',?,?)`,
        ).run(
            id,
            `fixture-${id}`,
            `0xcollection${id}`,
            COLLECTION_STATUS.Live,
            `fixture-${id}`,
            OPENSEA_COLLECTION_STATUS.Ready,
        );
    }
    function completed(
        reconcile: string | null,
        snapshot: string | null = null,
        id = 99,
    ) {
        db.prepare(
            "UPDATE collections SET opensea_reconcile_completed_at=?, opensea_snapshot_completed_at=? WHERE collection_id=?",
        ).run(reconcile, snapshot, id);
    }
    const due = (cutoff: number | null, collectionId?: number) =>
        collections
            .listCollectionsForOpenSeaReconcile(1, cutoff, collectionId)
            .map((c) => c.id);
    const job = (
        reason: OpenSeaReconcileReason = REASON.Scheduled,
        id = 99,
        suffix = "old",
    ): JobEnvelope<OpenSeaReconcileCollectionPayload> => ({
        jobId: `${OPENSEA_JOB_ID_SCOPE.ReconcileCollection}:1:${id}:${reason}:${suffix}`,
        kind: OPENSEA_JOB_KIND.ReconcileCollection,
        queue: OPENSEA_QUEUE_NAME.Reconcile,
        payload: { chainId: 1, collectionId: id, reason },
        attempt: 1,
        scheduledAt: 0,
        chainId: 1,
        collectionId: id,
    });
    const handle = (
        envelope = job(),
        pipeline: Pick<OpenSeaOrderbookSync, "syncCollection"> = sync,
        now: () => number = Date.now,
    ) =>
        handleReconcileJob(
            queue,
            collections,
            runs,
            pipeline,
            freshness,
            thresholds.retryPolicy,
            envelope,
            now,
        );
    const runRows = () =>
        db
            .prepare(
                "SELECT status FROM opensea_orderbook_runs ORDER BY run_id",
            )
            .all();

    it("compares SQLite completion text chronologically against an ISO-derived cutoff", () => {
        const cutoff = Date.parse("2026-09-23T21:35:00.000Z");
        completed("2026-09-23 21:46:30");
        expect(due(cutoff)).toEqual([]);
        completed("2026-09-23 21:30:00");
        expect(due(cutoff)).toEqual([99]);
    });

    it.each([
        ["2026-09-23 21:34:59.999", true],
        ["2026-09-23 21:35:00", true],
        ["2026-09-23T21:35:00.001Z", false],
        ["2026-09-23T23:35:00.001+02:00", false],
        ["2026-09-23T23:35:00.000+02:00", true],
    ])("uses the inclusive instant boundary for %s", (timestamp, expected) => {
        completed(timestamp);
        expect(due(Date.parse("2026-09-23T21:35:00Z"))).toEqual(
            expected ? [99] : [],
        );
    });

    it("handles UTC midnight and never-refreshed collections", () => {
        expect(due(Date.parse("2026-09-24T00:00:00Z"))).toEqual([99]);
        completed("2026-09-23 23:59:59");
        expect(due(Date.parse("2026-09-24T00:00:00Z"))).toEqual([99]);
        completed("2026-09-24 00:00:01");
        expect(due(Date.parse("2026-09-24T00:00:00Z"))).toEqual([]);
    });

    it.each([
        [null, "2026-09-23 21:46:30"],
        ["2026-09-23 21:30:00", "2026-09-23 21:46:30"],
        ["2026-09-23 21:46:30", "2026-09-23 21:30:00"],
    ])(
        "uses the latest successful snapshot or reconciliation",
        (reconcile, snapshot) => {
            completed(reconcile, snapshot);
            expect(due(Date.parse("2026-09-23T21:35:00Z"))).toEqual([]);
        },
    );

    it("does not count started scans, stream events or unsuccessful attempts as success", () => {
        db.prepare(
            `UPDATE collections SET opensea_reconcile_started_at=CURRENT_TIMESTAMP,
            opensea_snapshot_started_at=CURRENT_TIMESTAMP, opensea_last_stream_event_at=CURRENT_TIMESTAMP,
            opensea_last_stream_healthy_at=CURRENT_TIMESTAMP, opensea_status=?`,
        ).run(OPENSEA_COLLECTION_STATUS.Retrying);
        expect(due(Date.now())).toEqual([99]);
    });

    it("orders never-refreshed first, then oldest completion with a stable ID tie-breaker", () => {
        seed(2);
        seed(3);
        seed(4);
        seed(5);
        completed("2026-09-23 21:00:00", null, 99);
        completed("2026-09-23 19:00:00", null, 3);
        completed(null, "2026-09-23 19:00:00", 4);
        completed(null, "2026-09-23 20:00:00", 5);
        expect(due(Date.parse("2026-09-23T22:00:00Z"))).toEqual([
            2, 3, 4, 5, 99,
        ]);
        expect(due(null, 4)).toEqual([4]);
        expect(collections.listCollectionsForOpenSeaReconcile(2, null)).toEqual(
            [],
        );
    });

    it("preserves 15-minute periodic and 30-minute startup thresholds in scheduling and consumption", async () => {
        expect(thresholds.reconcileIntervalMs).toBe(15 * 60_000);
        expect(thresholds.staleStartThresholdMs).toBe(30 * 60_000);
        const now = Date.parse("2026-09-23T22:00:00Z");
        completed("2026-09-23 21:40:00");
        await scheduleDueReconciles(
            queue,
            collections,
            1,
            freshness,
            REASON.StartupStale,
            now,
        );
        expect(queue.publish).not.toHaveBeenCalled();
        await handle(job(REASON.StartupStale), sync, () => now);
        expect(sync.syncCollection).not.toHaveBeenCalled();
        await scheduleDueReconciles(
            queue,
            collections,
            1,
            freshness,
            REASON.Scheduled,
            now,
        );
        const envelope = queue.publish.mock.calls[0][1];
        expect(envelope.payload.reason).toBe(REASON.Scheduled);
        expect(envelope.jobId).toBe(
            `${OPENSEA_JOB_ID_SCOPE.ReconcileCollection}:1:99:${REASON.Scheduled}:${freshness.scheduledJobBucket(now)}`,
        );
        await handle(envelope, sync, () => now);
        expect(sync.syncCollection).toHaveBeenCalledOnce();
    });

    it("rechecks success after a request waited in the queue", async () => {
        await scheduleDueReconciles(
            queue,
            collections,
            1,
            freshness,
            REASON.Scheduled,
        );
        const envelope = queue.publish.mock.calls[0][1];
        collections.markOpenSeaSnapshotCompleted(1, 99);
        await handle(envelope);
        expect(sync.syncCollection).not.toHaveBeenCalled();
        expect(runRows()).toEqual([]);
    });

    it("drains a 541-envelope backlog with one useful scan per stale collection", async () => {
        const ids = [99, 2, 3, 4, 5, 6, 7, 8];
        for (const id of ids.slice(1)) seed(id);
        const counts = [92, 65, 64, 64, 64, 64, 64, 64];
        const reasons = [REASON.Scheduled, REASON.StartupStale, REASON.Retry];
        for (const [index, id] of ids.entries()) {
            for (let i = 0; i < counts[index]; i++)
                await handle(job(reasons[i % reasons.length], id, String(i)));
            expect(sync.syncCollection).toHaveBeenCalledTimes(index + 1);
        }
        expect(runRows()).toHaveLength(8);
        expect(queue.publish).not.toHaveBeenCalled();
    });

    it.each([REASON.Scheduled, REASON.StartupStale, REASON.Retry])(
        "skips fresh %s hints without any persistent writes or pipeline work",
        async (reason) => {
            collections.markOpenSeaReconcileCompleted(1, 99);
            const writes = db.prepare("SELECT total_changes() AS n").get();
            const sourceState = new SqliteOrderSourceStateStore({
                refreshSeller: vi.fn(),
            });
            const begin = vi.spyOn(sourceState, "beginObservation");
            const api = { forEachListing: vi.fn(), forEachOffer: vi.fn() };
            const pipeline = new OpenSeaOrderbookSync(api, queue, sourceState);
            for (let i = 0; i < 64; i++)
                await handle(job(reason, 99, String(i)), pipeline);
            expect(api.forEachListing).not.toHaveBeenCalled();
            expect(api.forEachOffer).not.toHaveBeenCalled();
            expect(begin).not.toHaveBeenCalled();
            expect(queue.publish).not.toHaveBeenCalled();
            expect(runRows()).toEqual([]);
            expect(db.prepare("SELECT total_changes() AS n").get()).toEqual(
                writes,
            );
        },
    );

    it("keeps an old failed hint eligible, retries it, and suppresses a superseded retry", async () => {
        sync.syncCollection.mockRejectedValueOnce(new Error("partial fixture"));
        const envelope = job();
        await handle(envelope);
        expect(
            collections.getCollection(1, 99)?.openseaReconcileCompletedAt,
        ).toBeNull();
        expect(runRows()).toEqual([{ status: "failed" }]);
        const retry = queue.publish.mock.calls[0][1];
        expect(retry.payload.reason).toBe(REASON.Retry);
        expect(retry.scheduledAt).toBeGreaterThan(Date.now());
        // Seeing the same job ID does not prevent retrying unsatisfied work.
        await handle(envelope);
        expect(runRows()).toEqual([
            { status: "failed" },
            { status: "completed" },
        ]);
        await handle(retry);
        expect(sync.syncCollection).toHaveBeenCalledTimes(2);
    });

    it("nacks through the caller if retry publication fails, without advancing freshness", async () => {
        sync.syncCollection.mockRejectedValueOnce(
            new Error("upstream unavailable"),
        );
        queue.publish.mockRejectedValueOnce(new Error("queue unavailable"));
        await expect(handle()).rejects.toThrow("queue unavailable");
        expect(
            collections.getCollection(1, 99)?.openseaReconcileCompletedAt,
        ).toBeNull();
    });

    it("preserves manual force-refresh for a fresh collection", async () => {
        collections.markOpenSeaReconcileCompleted(1, 99);
        await handle(job(REASON.Manual));
        expect(sync.syncCollection).toHaveBeenCalledOnce();
        expect(runRows()).toEqual([{ status: "completed" }]);
    });

    it("retains manual force intent after a failed fresh-collection refresh", async () => {
        collections.markOpenSeaReconcileCompleted(1, 99);
        sync.syncCollection.mockRejectedValueOnce(
            new Error("manual attempt failed"),
        );
        await handle(job(REASON.Manual));
        const retry = queue.publish.mock.calls[0][1];
        expect(retry.payload.reason).toBe(REASON.Manual);
        await handle(retry);
        expect(sync.syncCollection).toHaveBeenCalledTimes(2);
        expect(runRows()).toEqual([
            { status: "failed" },
            { status: "completed" },
        ]);
    });

    it.each([
        COLLECTION_STATUS.Bootstrapping,
        COLLECTION_STATUS.Prepared,
        COLLECTION_STATUS.Paused,
        COLLECTION_STATUS.Disabled,
    ])(
        "ignores queued work for a non-live collection (%s), including manual work",
        async (status) => {
            db.prepare("UPDATE collections SET status=?").run(status);
            for (const reason of Object.values(REASON))
                await handle(job(reason));
            expect(sync.syncCollection).not.toHaveBeenCalled();
            expect(runRows()).toEqual([]);
        },
    );

    it("ignores removed collections and collections without OpenSea identity", async () => {
        db.prepare(
            "UPDATE collections SET opensea_slug=NULL WHERE collection_id=99",
        ).run();
        await handle();
        db.prepare(
            "UPDATE collections SET opensea_slug='', opensea_status=NULL WHERE collection_id=99",
        ).run();
        await handle(job(REASON.Manual));
        db.prepare("DELETE FROM collections").run();
        await handle();
        expect(sync.syncCollection).not.toHaveBeenCalled();
        expect(runRows()).toEqual([]);
    });

    it("completes listings then offers before committing absence evidence and collection freshness", async () => {
        const events: string[] = [];
        db.prepare(
            `INSERT INTO orders(id,chain_id,collection_id,kind,maker,contract_address,source,source_status,fillability_status,observed_at)
            VALUES ('absent',1,99,'seaport','maker','0xcollection',?,?,?,0)`,
        ).run(
            OFFCHAIN_ORDER_SOURCE.OpenSea,
            ORDER_SOURCE_STATUS.Active,
            ORDER_STATUS.Fillable,
        );
        let fail = true;
        type Api = ConstructorParameters<typeof OpenSeaOrderbookSync>[0];
        const api = {
            forEachListing: vi.fn<Api["forEachListing"]>(
                async (_slug, _address, receive) => {
                    events.push("listings");
                    await receive({
                        eventType: "fixture",
                        orderId: "listing",
                        sourceEventAt: null,
                        payload: {},
                    });
                },
            ),
            forEachOffer: vi.fn<Api["forEachOffer"]>(
                async (_slug, _address, receive) => {
                    events.push("offers");
                    expect(
                        collections.getCollection(1, 99)
                            ?.openseaReconcileCompletedAt,
                    ).toBeNull();
                    if (fail) throw new Error("incomplete offers");
                    await receive({
                        eventType: "fixture",
                        orderId: "offer",
                        sourceEventAt: null,
                        payload: {},
                    });
                },
            ),
        };
        const pipeline = new OpenSeaOrderbookSync(
            api,
            queue,
            new SqliteOrderSourceStateStore({ refreshSeller: vi.fn() }),
        );
        await handle(job(), pipeline);
        expect(events).toEqual(["listings", "offers"]);
        expect(
            collections.getCollection(1, 99)?.openseaReconcileCompletedAt,
        ).toBeNull();
        const status = () =>
            db
                .prepare("SELECT source_status FROM orders WHERE id='absent'")
                .get();
        expect(status()).toEqual({ source_status: ORDER_SOURCE_STATUS.Active });
        expect(
            db.prepare("SELECT * FROM market_order_observations").all(),
        ).toEqual([]);
        fail = false;
        await handle(job(REASON.Retry), pipeline);
        expect(status()).toEqual({
            source_status: ORDER_SOURCE_STATUS.Inactive,
        });
        expect(
            collections.getCollection(1, 99)?.openseaReconcileCompletedAt,
        ).not.toBeNull();
        expect(runRows()).toEqual([
            { status: "failed" },
            { status: "completed" },
        ]);
        expect(
            db
                .prepare(
                    "SELECT name FROM sqlite_temp_schema WHERE name LIKE 'market_observation_%'",
                )
                .all(),
        ).toEqual([]);
    });

    it("correlates start and completion logs without storing skip history", async () => {
        await handle();
        expect(logger.info).toHaveBeenCalledWith(
            "OpenSea reconcile started",
            expect.objectContaining({
                jobId: job().jobId,
                collectionId: 99,
                reason: REASON.Scheduled,
                attempt: 1,
            }),
        );
        expect(logger.info).toHaveBeenCalledWith(
            "OpenSea reconcile completed",
            expect.objectContaining({
                jobId: job().jobId,
                durationMs: expect.any(Number),
                runId: expect.any(Number),
            }),
        );
        vi.mocked(logger.info).mockClear();
        await handle();
        expect(logger.info).not.toHaveBeenCalled();
        expect(logger.debug).toHaveBeenCalledOnce();
    });
});
