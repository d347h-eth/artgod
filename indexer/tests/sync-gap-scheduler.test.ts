import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createMigrationRunner } from "@artgod/shared/migrations";
import { db, setDbPath } from "@artgod/shared/database";
import { COLLECTION_STATUS, type CollectionStatus } from "@artgod/shared/types";
import { COLLECTION_STANDARD } from "../src/domain/collections.js";
import {
    BACKFILL_ORDER_MAINTENANCE_POLICY,
    BACKFILL_SOURCE,
    SYNC_JOB_KIND,
    type BackfillSyncPayload,
} from "../src/domain/sync-jobs.js";
import type { JobEnvelope } from "../src/domain/jobs.js";
import { QUEUE_NAMES } from "../src/domain/queues.js";
import type { QueuePort } from "../src/ports/queue.js";
import {
    SyncGapScheduler,
    executeSyncGapRepair,
    isCurrentSyncGapRepair,
    type SyncGapSchedulerOptions,
} from "../src/application/sync-gap-scheduler.js";
import { SqliteCollectionRegistry } from "../src/infra/collections/sqlite.js";
import { SqliteSyncGapStore } from "../src/infra/storage/sqlite-sync-gaps.js";
import { SqliteStorage } from "../src/infra/storage/sqlite.js";
import { createTempDbPath } from "./helpers/test-helpers.js";
import { loadTestEnv } from "./helpers/test-env.js";

type RepairJob = JobEnvelope<BackfillSyncPayload>;

describe("perpetual collection gap repair", () => {
    loadTestEnv();
    let testDbPath: string;
    beforeAll(async () => {
        testDbPath = await createTempDbPath();
        setDbPath(testDbPath);
        await createMigrationRunner().runMigrations();
    });
    beforeEach(() => {
        db.exec("DELETE FROM collections; DELETE FROM blocks;");
    });

    it("finds internal holes behind last-synced progress even when global blocks exist", async () => {
        const id = seedCollection(100);
        const h = harness();
        cover(id, 100, 120, [100, 107, 108]);
        db.prepare(
            "UPDATE collections SET bootstrap_last_synced_block = ? WHERE collection_id = ?",
        ).run(120, id);
        for (let block = 100; block <= 120; block++) {
            db.prepare(
                "INSERT INTO blocks (chain_id, block_number, block_hash, parent_hash, timestamp) VALUES (1, ?, 'hash', 'parent', 1)",
            ).run(block);
        }
        await h.scheduler.scan(120);
        expect(h.jobs).toHaveLength(1);
        expect(h.jobs[0]).toMatchObject({
            chainId: 1,
            collectionId: id,
            kind: SYNC_JOB_KIND.BackfillRange,
            queue: QUEUE_NAMES.BackfillSync,
            payload: {
                fromBlock: 107,
                toBlock: 108,
                source: BACKFILL_SOURCE.GapRepair,
                orderMaintenancePolicy:
                    BACKFILL_ORDER_MAINTENANCE_POLICY.CurrentState,
            },
        });
        h.finish(h.jobs[0]);
        await h.scheduler.scan(120);
        expect(h.jobs[1].payload).toMatchObject({
            fromBlock: 100,
            toBlock: 100,
        });
        h.finish(h.jobs[1]);
        await h.scheduler.scan(120);
        expect(h.jobs).toHaveLength(2);
    });

    it("resumes bounded descending sweeps after restart while head keeps growing", async () => {
        const id = seedCollection(100);
        const h = harness({ scanWindowBlocks: 4, batchSize: 2 });
        cover(id, 100, 112, [100, 101, 102, 103, 104, 105, 106]);
        await h.scheduler.scan(110);
        expect(h.jobs).toHaveLength(0);
        expect(h.store.getProgress(1, id)?.cursorBlock).toBe(106);
        h.restart();
        await h.scheduler.scan(111);
        expect(h.jobs[0].payload).toMatchObject({
            fromBlock: 105,
            toBlock: 106,
        });
        for (let i = 0; i < 4; i++) {
            h.finish(h.jobs[i]);
            await h.scheduler.scan(112);
        }
        expect(
            h.jobs.map((job) => [job.payload.fromBlock, job.payload.toBlock]),
        ).toEqual([
            [105, 106],
            [103, 104],
            [101, 102],
            [100, 100],
        ]);
        expect(h.store.getProgress(1, id)?.cursorBlock).toBe(108);
        expect(h.jobs.every((job) => job.payload.fromBlock >= 100)).toBe(true);
    });

    it("revisits fully covered history at a stationary head and sees reorg deletions", async () => {
        const id = seedCollection(100);
        const h = harness();
        cover(id, 100, 110);
        await h.scheduler.scan(110);
        expect(h.jobs).toHaveLength(0);
        db.prepare(
            "DELETE FROM collection_sync_blocks WHERE collection_id = ? AND block_number = 101",
        ).run(id);
        await h.scheduler.scan(110);
        expect(h.jobs[0].payload).toMatchObject({
            fromBlock: 101,
            toBlock: 101,
        });
        h.finish(h.jobs[0]);
        new SqliteStorage().rollbackFromBlock(1, 108);
        await h.scheduler.scan(110);
        await h.scheduler.scan(110);
        expect(h.jobs[1].payload).toMatchObject({
            fromBlock: 109,
            toBlock: 110,
        });
        expect(h.jobs[1].jobId).not.toBe(h.jobs[0].jobId);
    });

    it("repairs newly live collections and scopes gaps to their own anchor and chain", async () => {
        const first = seedCollection(100);
        const second = seedCollection(105, COLLECTION_STATUS.Bootstrapping);
        seedCollection(100, COLLECTION_STATUS.Prepared);
        seedCollection(100, COLLECTION_STATUS.Paused);
        seedCollection(100, COLLECTION_STATUS.Disabled);
        seedCollection(null);
        seedCollection(130);
        seedCollection(100, COLLECTION_STATUS.Live, 2);
        const h = harness();
        cover(first, 100, 110);
        await h.scheduler.scan(110);
        expect(h.jobs).toHaveLength(0);
        db.prepare(
            "UPDATE collections SET status = ? WHERE collection_id = ?",
        ).run(COLLECTION_STATUS.Live, second);
        await h.scheduler.scan(110);
        expect(h.jobs).toHaveLength(1);
        expect(h.jobs[0]).toMatchObject({
            chainId: 1,
            collectionId: second,
            payload: { fromBlock: 109, toBlock: 110 },
        });
    });

    it("persists publish intent, retries the same identity after restart, and bounds outstanding work", async () => {
        const id = seedCollection(100);
        const h = harness();
        h.publish.mockRejectedValueOnce(new Error("broker unavailable"));
        await h.scheduler.scan(110);
        const pending = h.store.getProgress(1, id)?.pending;
        expect(pending?.fromBlock).toBe(109);
        h.restart();
        await h.scheduler.scan(110);
        expect(h.jobs[0].jobId).toBe(pending?.jobId);
        for (let i = 0; i < 10; i++) await h.scheduler.scan(111);
        expect(h.jobs).toHaveLength(1);
        h.advance(100);
        await h.scheduler.scan(111);
        expect(h.jobs).toHaveLength(2);
        expect(h.jobs[1].jobId).toBe(h.jobs[0].jobId);
        expect(h.store.getProgress(1, id)?.cursorBlock).toBe(108);
    });

    it("keeps a partially executed repair pending until downstream publication completes", async () => {
        const id = seedCollection(100);
        const h = harness();
        await h.scheduler.scan(102);
        const job = h.jobs[0];
        cover(id, job.payload.fromBlock, job.payload.toBlock);
        h.restart();
        h.advance(100);
        await h.scheduler.scan(102);
        expect(h.jobs[1].jobId).toBe(job.jobId);
        expect(
            isCurrentSyncGapRepair(
                job,
                h.registry.getCollection(1, id),
                h.store,
            ),
        ).toBe(true);
        h.store.completeRepair(1, id, "unrelated-job");
        expect(h.store.getProgress(1, id)?.pending?.jobId).toBe(job.jobId);
        h.finish(job);
        expect(
            isCurrentSyncGapRepair(
                job,
                h.registry.getCollection(1, id),
                h.store,
            ),
        ).toBe(false);
        await h.scheduler.scan(102);
        // A late publication response cannot overwrite the next repair's retry.
        h.store.deferRetry(1, id, job.jobId, 9999);
        expect(h.store.getProgress(1, id)?.pending?.jobId).toBe(
            h.jobs[2].jobId,
        );
        expect(h.store.getProgress(1, id)?.pending?.retryAt).not.toBe(9999);
    });

    it("recovers unpublished intent after closing and reopening SQLite", async () => {
        const id = seedCollection(100);
        const before = harness();
        before.publish.mockRejectedValueOnce(new Error("publish interrupted"));
        await before.scheduler.scan(110);
        const saved = before.store.getProgress(1, id);
        setDbPath(testDbPath);
        const after = harness();
        await after.scheduler.scan(110);
        expect(after.jobs[0].jobId).toBe(saved?.pending?.jobId);
        expect(after.store.getProgress(1, id)?.cursorBlock).toBe(
            saved?.cursorBlock,
        );
    });

    it("pages collections fairly even when the first collection is stuck or publishing fails", async () => {
        const ids = Array.from({ length: 5 }, () => seedCollection(100));
        const h = harness({ collectionsPerPass: 2 });
        h.publish.mockRejectedValueOnce(new Error("first publication failed"));
        await h.scheduler.scan(110);
        expect(h.publish).toHaveBeenCalledTimes(2);
        await h.scheduler.scan(110);
        await h.scheduler.scan(110);
        expect(h.jobs.map((job) => job.collectionId)).toEqual(ids.slice(1));
        await h.scheduler.scan(110);
        expect(h.jobs.at(-1)?.collectionId).toBe(ids[0]);
        expect(h.jobs).toHaveLength(5);
    });

    it("retries failed worker fanout and acknowledges late duplicate deliveries without running them", async () => {
        const id = seedCollection(100);
        const h = harness();
        await h.scheduler.scan(102);
        const job = h.jobs[0];
        const work = vi.fn(async () => {
            cover(id, job.payload.fromBlock, job.payload.toBlock);
            throw new Error("downstream publish failed");
        });
        await expect(
            executeSyncGapRepair(job, h.registry, h.store, work),
        ).rejects.toThrow("downstream publish failed");
        expect(h.store.getProgress(1, id)?.pending?.jobId).toBe(job.jobId);
        const retry = vi.fn(async () => {});
        expect(
            await executeSyncGapRepair(job, h.registry, h.store, retry),
        ).toBe(true);
        expect(h.store.getProgress(1, id)?.pending).toBeNull();
        expect(
            await executeSyncGapRepair(job, h.registry, h.store, retry),
        ).toBe(false);
        expect(retry).toHaveBeenCalledTimes(1);
    });

    it("does not execute queued repairs after a collection is paused", async () => {
        const id = seedCollection(100);
        const h = harness();
        await h.scheduler.scan(102);
        db.prepare(
            "UPDATE collections SET status = ? WHERE collection_id = ?",
        ).run(COLLECTION_STATUS.Paused, id);
        const work = vi.fn(async () => {});
        expect(
            await executeSyncGapRepair(h.jobs[0], h.registry, h.store, work),
        ).toBe(false);
        expect(work).not.toHaveBeenCalled();
        db.prepare(
            "UPDATE collections SET status = ? WHERE collection_id = ?",
        ).run(COLLECTION_STATUS.Live, id);
        h.advance(100);
        await h.scheduler.scan(102);
        expect(h.jobs[1].jobId).toBe(h.jobs[0].jobId);
        expect(
            await executeSyncGapRepair(h.jobs[1], h.registry, h.store, work),
        ).toBe(true);
    });

    it("rejects stale repairs after status changes, anchor changes, completion, and purge", async () => {
        const id = seedCollection(100);
        const h = harness();
        await h.scheduler.scan(110);
        const job = h.jobs[0];
        const valid = () =>
            isCurrentSyncGapRepair(
                job,
                h.registry.getCollection(1, id),
                h.store,
            );
        expect(valid()).toBe(true);
        expect(
            isCurrentSyncGapRepair(
                { ...job, collectionId: undefined },
                h.registry.getCollection(1, id),
                h.store,
            ),
        ).toBe(false);
        expect(
            isCurrentSyncGapRepair(
                { ...job, chainId: 2 },
                h.registry.getCollection(1, id),
                h.store,
            ),
        ).toBe(false);
        for (const status of [
            COLLECTION_STATUS.Paused,
            COLLECTION_STATUS.Disabled,
            COLLECTION_STATUS.Bootstrapping,
        ]) {
            db.prepare(
                "UPDATE collections SET status = ? WHERE collection_id = ?",
            ).run(status, id);
            expect(valid()).toBe(false);
        }
        db.prepare(
            "UPDATE collections SET status = ?, bootstrap_anchor_block = 105 WHERE collection_id = ?",
        ).run(COLLECTION_STATUS.Live, id);
        expect(valid()).toBe(false);
        await h.scheduler.scan(110);
        expect(h.jobs[1].jobId).not.toBe(job.jobId);
        expect(h.store.getProgress(1, id)?.anchorBlock).toBe(105);
        db.prepare("DELETE FROM collections WHERE collection_id = ?").run(id);
        expect(valid()).toBe(false);
        expect(h.store.getProgress(1, id)).toBeNull();
    });

    it("coalesces overlapping passes and waits for the pending publication", async () => {
        seedCollection(100);
        const h = harness();
        let release!: () => void;
        h.publish.mockImplementationOnce(
            () =>
                new Promise<void>((resolve) => {
                    release = resolve;
                }),
        );
        const first = h.scheduler.scan(110);
        const second = h.scheduler.scan(111);
        expect(first).toBe(second);
        expect(h.publish).toHaveBeenCalledTimes(1);
        release();
        await first;
    });

    it("bounds empty history, does not schedule above a regressed head, and checks the anchor itself", async () => {
        const id = seedCollection(100);
        const h = harness({ batchSize: 1000, scanWindowBlocks: 3 });
        await h.scheduler.scan(104);
        expect(h.jobs[0].payload).toMatchObject({
            fromBlock: 102,
            toBlock: 104,
        });
        h.advance(100);
        await h.scheduler.scan(101);
        expect(h.jobs).toHaveLength(1);
        h.finish(h.jobs[0]);
        await h.scheduler.scan(101);
        expect(h.jobs[1].payload).toMatchObject({
            fromBlock: 100,
            toBlock: 101,
        });
        h.finish(h.jobs[1]);
        await h.scheduler.scan(100);
        expect(h.jobs).toHaveLength(2);
        expect(h.store.getProgress(1, id)?.cursorBlock).toBeNull();
    });

    it("finds exactly the uncovered blocks for every small coverage shape", () => {
        const id = seedCollection(100);
        const store = new SqliteSyncGapStore();
        for (let mask = 0; mask < 64; mask++) {
            db.prepare(
                "DELETE FROM collection_sync_blocks WHERE collection_id = ?",
            ).run(id);
            const missing = Array.from({ length: 6 }, (_, i) => 100 + i).filter(
                (_, i) => !(mask & (1 << i)),
            );
            cover(id, 100, 105, missing);
            const found: number[] = [];
            let cursor = 105;
            while (cursor >= 100) {
                const gap = store.findGap(
                    1,
                    id,
                    { fromBlock: 100, toBlock: cursor },
                    2,
                );
                if (!gap) break;
                expect(gap.toBlock - gap.fromBlock + 1).toBeLessThanOrEqual(2);
                for (let block = gap.toBlock; block >= gap.fromBlock; block--)
                    found.push(block);
                cursor = gap.fromBlock - 1;
            }
            expect(found).toEqual([...missing].reverse());
        }
    });
});

function harness(overrides: Partial<SyncGapSchedulerOptions> = {}) {
    const registry = new SqliteCollectionRegistry();
    const store = new SqliteSyncGapStore();
    const jobs: RepairJob[] = [];
    let now = 1000;
    const publish = vi.fn<QueuePort["publish"]>(async (_queue, job) => {
        jobs.push(job as RepairJob);
    });
    const options = {
        chainId: 1,
        batchSize: 2,
        scanWindowBlocks: 100,
        retryDelayMs: 100,
        now: () => now,
        ...overrides,
    };
    const create = () =>
        new SyncGapScheduler(registry, store, { publish }, options);
    return {
        registry,
        store,
        jobs,
        publish,
        scheduler: create(),
        restart() {
            this.scheduler = create();
        },
        advance(ms: number) {
            now += ms;
        },
        finish(job: RepairJob) {
            cover(
                job.collectionId!,
                job.payload.fromBlock,
                job.payload.toBlock,
            );
            store.completeRepair(job.chainId, job.collectionId!, job.jobId);
        },
    };
}

function seedCollection(
    anchor: number | null,
    status: CollectionStatus = COLLECTION_STATUS.Live,
    chainId = 1,
): number {
    const result = db
        .prepare(
            "INSERT INTO collections (chain_id, slug, address, standard, status, token_scope_kind, bootstrap_anchor_block) " +
                "VALUES (?, ?, ?, ?, ?, 'contract_all_tokens', ?)",
        )
        .run(
            chainId,
            `collection-${crypto.randomUUID()}`,
            "0xabc0000000000000000000000000000000000000",
            COLLECTION_STANDARD.Erc721,
            status,
            anchor,
        );
    return Number(result.lastInsertRowid);
}

function cover(
    collectionId: number,
    fromBlock: number,
    toBlock: number,
    missing: number[] = [],
): void {
    const stmt = db.prepare(
        "INSERT OR IGNORE INTO collection_sync_blocks (chain_id, collection_id, block_number) VALUES (1, ?, ?)",
    );
    db.writeTransaction(() => {
        for (let block = fromBlock; block <= toBlock; block++)
            if (!missing.includes(block)) stmt.run(collectionId, block);
    })();
}
