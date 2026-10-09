import { commitRollbackFixture } from "./helpers/rollback-fixture.js";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createMigrationRunner } from "@artgod/shared/migrations";
import { db, setDbPath } from "@artgod/shared/database";
import { COLLECTION_STATUS, type CollectionStatus } from "@artgod/shared/types";
import { COLLECTION_STANDARD } from "../src/domain/collections.js";
import {
    isCurrentSyncGapRepair,
    type SyncGapRepairTarget,
} from "../src/domain/sync-gap-repair.js";
import {
    SyncGapScheduler,
    type SyncGapSchedulerOptions,
} from "../src/application/sync-gap-scheduler.js";
import { SqliteCollectionRegistry } from "../src/infra/collections/sqlite.js";
import { SqliteSyncGapStore } from "../src/infra/storage/sqlite-sync-gaps.js";
import { SqliteStorage } from "../src/infra/storage/sqlite.js";
import { createTempDbPath } from "./helpers/test-helpers.js";
import { loadTestEnv } from "./helpers/test-env.js";

describe("durable collection gap scanning", () => {
    loadTestEnv();
    let testDbPath: string;
    beforeAll(async () => {
        testDbPath = await createTempDbPath();
        setDbPath(testDbPath);
        await createMigrationRunner().runMigrations();
    });
    beforeEach(() =>
        db.exec(
            "DELETE FROM collections; DELETE FROM blocks; DELETE FROM queue_outbox;",
        ),
    );

    it("finds holes behind last-synced progress despite global block presence", async () => {
        const id = seedCollection(100),
            h = harness();
        cover(id, 100, 120, [100, 107, 108]);
        db.prepare(
            "UPDATE collections SET bootstrap_last_synced_block = 120 WHERE collection_id = ?",
        ).run(id);
        for (let n = 100; n <= 120; n++)
            db.prepare(
                "INSERT INTO blocks (chain_id, block_number, block_hash, parent_hash, timestamp) VALUES (1, ?, 'hash', 'parent', 1)",
            ).run(n);
        await h.scheduler.scan(120);
        expect(h.due()).toEqual([
            expect.objectContaining({
                collectionId: id,
                fromBlock: 107,
                toBlock: 108,
            }),
        ]);
        h.finish(h.due()[0]);
        await h.scheduler.scan(120);
        expect(h.due()).toEqual([
            expect.objectContaining({ fromBlock: 100, toBlock: 100 }),
        ]);
        h.finish(h.due()[0]);
        await h.scheduler.scan(120);
        expect(h.due()).toEqual([]);
        expect(
            db.prepare("SELECT COUNT(*) AS count FROM queue_outbox").get(),
        ).toEqual({ count: 0 });
    });

    it("resumes bounded descending sweeps after restart while head grows", async () => {
        const id = seedCollection(100),
            h = harness({ scanWindowBlocks: 4 });
        cover(id, 100, 112, [100, 101, 102, 103, 104, 105, 106]);
        await h.scheduler.scan(110);
        expect(h.due()).toEqual([]);
        expect(h.store.getProgress(1, id)?.cursorBlock).toBe(106);
        h.restart();
        await h.scheduler.scan(111);
        const ranges: number[][] = [];
        for (let i = 0; i < 4; i++) {
            const repair = h.due()[0];
            ranges.push([repair.fromBlock, repair.toBlock]);
            h.finish(repair);
            await h.scheduler.scan(112);
        }
        expect(ranges).toEqual([
            [105, 106],
            [103, 104],
            [101, 102],
            [100, 100],
        ]);
        expect(h.store.getProgress(1, id)?.cursorBlock).toBe(108);
    });

    it("revisits stationary history and detects rollback deletions", async () => {
        const id = seedCollection(100),
            h = harness();
        cover(id, 100, 110);
        await h.scheduler.scan(110);
        expect(h.due()).toEqual([]);
        db.prepare(
            "DELETE FROM collection_sync_blocks WHERE collection_id = ? AND block_number = 101",
        ).run(id);
        await h.scheduler.scan(110);
        const first = h.due()[0];
        expect(first).toMatchObject({ fromBlock: 101, toBlock: 101 });
        h.finish(first);
        commitRollbackFixture({
            storage: new SqliteStorage(),
            chainId: 1,
            fromBlock: 108,
            owners: [],
        });
        await h.scheduler.scan(110);
        await h.scheduler.scan(110);
        expect(h.due()[0]).toMatchObject({ fromBlock: 109, toBlock: 110 });
        expect(h.due()[0].repairId).not.toBe(first.repairId);
    });

    it("admits newly live collections using only their own chain and anchor", async () => {
        const live = seedCollection(100),
            next = seedCollection(105, COLLECTION_STATUS.Bootstrapping);
        for (const status of [
            COLLECTION_STATUS.Prepared,
            COLLECTION_STATUS.Paused,
            COLLECTION_STATUS.Disabled,
        ])
            seedCollection(100, status);
        seedCollection(null);
        seedCollection(130);
        seedCollection(100, COLLECTION_STATUS.Live, 2);
        const h = harness();
        cover(live, 100, 110);
        await h.scheduler.scan(110);
        expect(h.due()).toEqual([]);
        db.prepare(
            "UPDATE collections SET status = ? WHERE collection_id = ?",
        ).run(COLLECTION_STATUS.Live, next);
        await h.scheduler.scan(110);
        expect(h.due()).toEqual([
            expect.objectContaining({
                collectionId: next,
                anchorBlock: 105,
                fromBlock: 109,
                toBlock: 110,
            }),
        ]);
    });

    it("retains one exact repair and cursor across reopen and repeated scans", async () => {
        const id = seedCollection(100),
            h = harness();
        await h.scheduler.scan(110);
        const saved = h.store.getProgress(1, id);
        setDbPath(testDbPath);
        const after = harness();
        for (let i = 0; i < 10; i++) await after.scheduler.scan(111);
        expect(after.store.getProgress(1, id)).toEqual(saved);
        expect(after.due()).toHaveLength(1);
        const repair = after.due()[0];
        after.store.deferRetry(1, repair, 2000);
        expect(after.due()).toEqual([]);
        after.advance(1000);
        expect(after.due()[0]).toEqual(repair);
    });

    it("does not let late completion or retry overwrite replacement intent", async () => {
        const id = seedCollection(100),
            h = harness();
        await h.scheduler.scan(110);
        const old = h.due()[0];
        h.finish(old);
        await h.scheduler.scan(110);
        const current = h.store.getProgress(1, id);
        expect(
            h.store.recordRepairProgress({
                chainId: 1,
                repair: old,
                remaining: null,
                retryAt: 0,
            }),
        ).toBe(false);
        h.store.deferRetry(1, old, 9999);
        expect(h.store.getProgress(1, id)).toEqual(current);
    });

    it("pages fairly even if one collection's scan fails", async () => {
        const ids = Array.from({ length: 5 }, () => seedCollection(100)),
            h = harness({ collectionsPerPass: 2 });
        vi.spyOn(h.store, "findGap").mockImplementationOnce(() => {
            throw new Error("scan failed");
        });
        for (let i = 0; i < 3; i++) await h.scheduler.scan(110);
        expect(h.due().map((repair) => repair.collectionId)).toEqual(
            ids.slice(1),
        );
        await h.scheduler.scan(110);
        expect(new Set(h.due().map((repair) => repair.collectionId))).toEqual(
            new Set(ids),
        );
    });

    it("rejects stale identity, status, chain, anchor and purge", async () => {
        const id = seedCollection(100),
            h = harness();
        await h.scheduler.scan(110);
        const repair = h.due()[0];
        const valid = (chainId = 1) =>
            isCurrentSyncGapRepair({
                chainId,
                repair,
                collection: h.registry.getCollection(1, id),
                progress: h.store.getProgress(1, id),
            });
        expect(valid()).toBe(true);
        expect(valid(2)).toBe(false);
        for (const status of [
            COLLECTION_STATUS.Paused,
            COLLECTION_STATUS.Disabled,
            COLLECTION_STATUS.Bootstrapping,
        ]) {
            db.prepare(
                "UPDATE collections SET status = ? WHERE collection_id = ?",
            ).run(status, id);
            expect(valid()).toBe(false);
            expect(h.due()).toEqual([]);
        }
        db.prepare(
            "UPDATE collections SET status = ?, bootstrap_anchor_block = 105 WHERE collection_id = ?",
        ).run(COLLECTION_STATUS.Live, id);
        expect(valid()).toBe(false);
        await h.scheduler.scan(110);
        expect(h.due()[0].repairId).not.toBe(repair.repairId);
        db.prepare("DELETE FROM collections WHERE collection_id = ?").run(id);
        expect(valid()).toBe(false);
        expect(h.store.getProgress(1, id)).toBeNull();
    });

    it("coalesces overlapping scanner passes", async () => {
        seedCollection(100);
        const h = harness();
        const find = vi.spyOn(h.store, "findGap");
        const first = h.scheduler.scan(110);
        expect(h.scheduler.scan(111)).toBe(first);
        await first;
        expect(find).toHaveBeenCalledOnce();
    });

    it("bounds empty history and includes the anchor after a regressed head", async () => {
        const id = seedCollection(100),
            h = harness({ batchSize: 1000, scanWindowBlocks: 3 });
        await h.scheduler.scan(104);
        const above = h.due()[0];
        expect(above).toMatchObject({ fromBlock: 102, toBlock: 104 });
        await h.scheduler.scan(101);
        expect(h.due()[0]).toEqual(above);
        h.finish(above);
        await h.scheduler.scan(101);
        expect(h.due()[0]).toMatchObject({ fromBlock: 100, toBlock: 101 });
        h.finish(h.due()[0]);
        await h.scheduler.scan(100);
        expect(h.due()).toEqual([]);
        expect(h.store.getProgress(1, id)?.cursorBlock).toBeNull();
    });

    it("finds precisely the uncovered blocks for every small coverage shape", () => {
        const id = seedCollection(100),
            store = new SqliteSyncGapStore();
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
                for (let n = gap.toBlock; n >= gap.fromBlock; n--)
                    found.push(n);
                cursor = gap.fromBlock - 1;
            }
            expect(found).toEqual([...missing].reverse());
        }
    });
});

function harness(overrides: Partial<SyncGapSchedulerOptions> = {}) {
    const registry = new SqliteCollectionRegistry(),
        store = new SqliteSyncGapStore();
    let now = 1000;
    const create = () =>
        new SyncGapScheduler(registry, store, {
            chainId: 1,
            batchSize: 2,
            scanWindowBlocks: 100,
            now: () => now,
            ...overrides,
        });
    return {
        registry,
        store,
        scheduler: create(),
        restart() {
            this.scheduler = create();
        },
        advance(ms: number) {
            now += ms;
        },
        due: () =>
            store.listDueRepairsAtNewestPendingHeight({
                chainId: 1,
                now,
                limit: 100,
            }),
        finish(repair: SyncGapRepairTarget) {
            cover(repair.collectionId, repair.fromBlock, repair.toBlock);
            expect(
                store.recordRepairProgress({
                    chainId: 1,
                    repair,
                    remaining: null,
                    retryAt: 0,
                }),
            ).toBe(true);
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
