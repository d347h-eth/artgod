import Database from "better-sqlite3";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { db, setDbPath } from "@artgod/shared/database";
import { createMigrationRunner } from "@artgod/shared/migrations";
import { COLLECTION_STATUS } from "@artgod/shared/types";
import {
    SyncGapScheduler,
    SYNC_GAP_POLICY,
} from "../src/application/sync-gap-scheduler.js";
import type { SyncGapProgress } from "../src/domain/sync-gap-repair.js";
import { SqliteCollectionRegistry } from "../src/infra/collections/sqlite.js";
import { SqliteSyncGapStore } from "../src/infra/storage/sqlite-sync-gaps.js";
import { insertCollection } from "./helpers/ownership-fixture.js";
import { createTempDbPath } from "./helpers/test-helpers.js";
import { loadTestEnv } from "./helpers/test-env.js";

describe("wall-clock HEAD gap checks", () => {
    loadTestEnv();
    let now: number;
    beforeAll(async () => {
        setDbPath(await createTempDbPath());
        await createMigrationRunner().runMigrations();
    });
    beforeEach(() => {
        db.exec("DELETE FROM collections");
        now = 2 * SYNC_GAP_POLICY.HeadRecheckIntervalMs;
    });

    function harness() {
        const registry = new SqliteCollectionRegistry();
        const store = new SqliteSyncGapStore();
        const scanner = () =>
            new SyncGapScheduler(registry, store, {
                chainId: 1,
                batchSize: 2,
                now: () => now,
            });
        return { registry, store, scanner };
    }

    function seed() {
        return insertCollection({
            chainId: 1,
            slug: `head-check-${crypto.randomUUID()}`,
            address: "0x1111111111111111111111111111111111111111",
            anchorBlock: 100,
        });
    }

    function retain(
        store: SqliteSyncGapStore,
        collectionId: number,
        progress: Partial<SyncGapProgress> = {},
    ) {
        expect(
            store.saveProgress({
                chainId: 1,
                collectionId,
                expected: store.getProgress(1, collectionId),
                progress: {
                    anchorBlock: 100,
                    cursorBlock: 100,
                    pending: {
                        repairId: `old:${collectionId}`,
                        fromBlock: 101,
                        toBlock: 102,
                        retryAt: now,
                    },
                    lastHeadCheckAt: now,
                    ...progress,
                },
            }),
        ).toBe(true);
    }

    it("checks at exactly 30 minutes, survives restart and resets to the newest hole", () => {
        let h = harness();
        const id = seed();
        retain(h.store, id);
        cover(id, 103, 200, [180, 181]);
        now += SYNC_GAP_POLICY.HeadRecheckIntervalMs - 1;
        expect(h.scanner().hasHeadRechecksDue()).toBe(false);
        expect(h.scanner().recheckFromHead(200)).toBe(false);
        now += 1;
        setDbPath(db.raw.name);
        h = harness();
        const restarted = h.scanner();
        expect(restarted.hasHeadRechecksDue()).toBe(true);
        expect(restarted.recheckFromHead(200)).toBe(true);
        expect(h.store.getProgress(1, id)).toMatchObject({
            cursorBlock: 179,
            lastHeadCheckAt: now,
            pending: { fromBlock: 180, toBlock: 181, retryAt: now },
        });
        expect(h.store.getProgress(1, id)?.pending?.repairId).not.toBe(
            `old:${id}`,
        );
        expect(h.scanner().hasHeadRechecksDue()).toBe(false);
    });

    it("counts shutdown time and checks overdue work on the first resumed pass", () => {
        const h = harness(),
            id = seed();
        retain(h.store, id);
        cover(id, 103, 200, [199, 200]);
        now += 18 * 60 * 60_000;
        expect(h.scanner().recheckFromHead(200)).toBe(true);
        expect(h.store.getProgress(1, id)?.pending).toMatchObject({
            fromBlock: 199,
            toBlock: 200,
        });
    });

    it("preserves exact pending identity, retry and cursor when newer history is covered", () => {
        const h = harness(),
            id = seed();
        retain(h.store, id, {
            pending: {
                repairId: "retrying",
                fromBlock: 101,
                toBlock: 102,
                retryAt: now + 50_000,
            },
        });
        const before = h.store.getProgress(1, id)!;
        cover(id, 103, 200);
        now += SYNC_GAP_POLICY.HeadRecheckIntervalMs;
        expect(h.scanner().recheckFromHead(200)).toBe(false);
        expect(h.store.getProgress(1, id)).toEqual({
            ...before,
            lastHeadCheckAt: now,
        });
    });

    it("checks above the cursor even with no pending repair", () => {
        const h = harness(),
            id = seed();
        retain(h.store, id, { pending: null, cursorBlock: 110 });
        cover(id, 111, 200, [150, 151]);
        now += SYNC_GAP_POLICY.HeadRecheckIntervalMs;
        expect(h.scanner().recheckFromHead(200)).toBe(true);
        expect(h.store.getProgress(1, id)).toMatchObject({
            cursorBlock: 149,
            pending: { fromBlock: 150, toBlock: 151 },
        });
    });

    it("does not rediscover the existing range or erase a range above a regressed HEAD", () => {
        const h = harness(),
            id = seed();
        retain(h.store, id, {
            pending: {
                repairId: "above-head",
                fromBlock: 150,
                toBlock: 160,
                retryAt: now,
            },
        });
        const pending = h.store.getProgress(1, id)!.pending;
        const lookup = vi.spyOn(h.store, "findNewestGap");
        now += SYNC_GAP_POLICY.HeadRecheckIntervalMs;
        expect(h.scanner().recheckFromHead(155)).toBe(false);
        expect(lookup).not.toHaveBeenCalled();
        expect(h.store.getProgress(1, id)?.pending).toEqual(pending);
        cover(id, 161, 200);
        now += SYNC_GAP_POLICY.HeadRecheckIntervalMs;
        expect(h.scanner().recheckFromHead(200)).toBe(false);
        expect(lookup).toHaveBeenCalledWith(
            1,
            id,
            { fromBlock: 161, toBlock: 200 },
            2,
        );
        expect(h.store.getProgress(1, id)?.pending).toEqual(pending);
    });

    it("retains older holes for ordinary backward scanning after the newer repair finishes", async () => {
        const h = harness(),
            id = seed();
        retain(h.store, id);
        cover(id, 100, 200, [101, 102, 190, 191]);
        now += SYNC_GAP_POLICY.HeadRecheckIntervalMs;
        const scanner = h.scanner();
        scanner.recheckFromHead(200);
        const repair = {
            ...h.store.getProgress(1, id)!.pending!,
            collectionId: id,
            anchorBlock: 100,
        };
        cover(id, repair.fromBlock, repair.toBlock);
        expect(
            h.store.recordRepairProgress({
                chainId: 1,
                repair,
                remaining: null,
                retryAt: now,
            }),
        ).toBe(true);
        await scanner.scan(200);
        expect(h.store.getProgress(1, id)?.pending).toMatchObject({
            fromBlock: 101,
            toBlock: 102,
        });
        expect(h.store.getProgress(1, id)?.lastHeadCheckAt).toBe(now);
    });

    it("checks never-checked migrated rows immediately and excludes inactive or changed anchors", () => {
        const h = harness();
        const active = seed(),
            paused = seed(),
            changed = seed(),
            otherChain = seed();
        for (const id of [active, paused, changed, otherChain])
            retain(h.store, id, { lastHeadCheckAt: null });
        db.prepare("UPDATE collections SET status=? WHERE collection_id=?").run(
            COLLECTION_STATUS.Paused,
            paused,
        );
        db.prepare(
            "UPDATE collections SET bootstrap_anchor_block=101 WHERE collection_id=?",
        ).run(changed);
        db.prepare(
            "UPDATE collections SET chain_id=2 WHERE collection_id=?",
        ).run(otherChain);
        const lookup = vi.spyOn(h.store, "findNewestGap");
        expect(h.scanner().recheckFromHead(200)).toBe(true);
        expect(lookup).toHaveBeenCalledOnce();
        expect(lookup.mock.calls[0][1]).toBe(active);
    });

    it("bounds membership and lets later collections pass a failed check", () => {
        const h = harness();
        const ids = Array.from(
            { length: SYNC_GAP_POLICY.CollectionsPerPass + 1 },
            seed,
        );
        for (const id of ids) retain(h.store, id, { lastHeadCheckAt: null });
        const lookup = vi.spyOn(h.store, "findNewestGap");
        lookup.mockImplementationOnce(() => {
            throw new Error("coverage read failed");
        });
        h.scanner().recheckFromHead(200);
        expect(lookup).toHaveBeenCalledTimes(
            SYNC_GAP_POLICY.CollectionsPerPass,
        );
        expect(h.store.getProgress(1, ids[0])?.lastHeadCheckAt).toBeNull();
        h.scanner().recheckFromHead(200);
        expect(h.store.getProgress(1, ids.at(-1)!)?.lastHeadCheckAt).toBe(now);
    });

    it.each([null, 0])(
        "checks later collections before LIMIT when 16 anchors exceed HEAD (check time=%s)",
        (lastHeadCheckAt) => {
            const h = harness();
            const blocked = Array.from(
                { length: SYNC_GAP_POLICY.CollectionsPerPass },
                seed,
            );
            for (const id of blocked) {
                db.prepare(
                    "UPDATE collections SET bootstrap_anchor_block=300 WHERE collection_id=?",
                ).run(id);
                retain(h.store, id, {
                    anchorBlock: 300,
                    cursorBlock: null,
                    pending: null,
                    lastHeadCheckAt,
                });
                cover(id, 300, 300);
            }
            const target = seed();
            retain(h.store, target, { lastHeadCheckAt });
            cover(target, 103, 200, [199, 200]);
            const scanner = h.scanner();
            expect(scanner.recheckFromHead(200)).toBe(true);
            expect(h.store.getProgress(1, target)).toMatchObject({
                cursorBlock: 198,
                lastHeadCheckAt: now,
                pending: { fromBlock: 199, toBlock: 200 },
            });
            for (const id of blocked)
                expect(h.store.getProgress(1, id)?.lastHeadCheckAt).toBe(
                    lastHeadCheckAt,
                );
            const restarted = h.scanner();
            expect(restarted.recheckFromHead(200)).toBe(false);
            now += 1000;
            expect(restarted.recheckFromHead(300)).toBe(false);
            for (const id of blocked)
                expect(h.store.getProgress(1, id)?.lastHeadCheckAt).toBe(now);
        },
    );

    it.each([
        [null, null],
        [null, 0],
        [0, 0],
    ])(
        "advances past a full page of persistent failures without marking it checked (%s -> %s)",
        (failedCheckTime, targetCheckTime) => {
            const h = harness();
            const blocked = Array.from(
                { length: SYNC_GAP_POLICY.CollectionsPerPass },
                seed,
            );
            for (const id of blocked)
                retain(h.store, id, { lastHeadCheckAt: failedCheckTime });
            const target = seed();
            retain(h.store, target, { lastHeadCheckAt: targetCheckTime });
            cover(target, 103, 200, [199, 200]);
            const original = h.store.findNewestGap.bind(h.store);
            const lookup = vi
                .spyOn(h.store, "findNewestGap")
                .mockImplementation((chainId, id, window, cap) => {
                    if (blocked.includes(id))
                        throw new Error("persistent coverage read failure");
                    return original(chainId, id, window, cap);
                });
            const scanner = h.scanner();
            expect(scanner.recheckFromHead(200)).toBe(false);
            expect(lookup).toHaveBeenCalledTimes(
                SYNC_GAP_POLICY.CollectionsPerPass,
            );
            expect(scanner.recheckFromHead(200)).toBe(true);
            expect(h.store.getProgress(1, target)).toMatchObject({
                lastHeadCheckAt: now,
                pending: { fromBlock: 199, toBlock: 200 },
            });
            for (const id of blocked)
                expect(h.store.getProgress(1, id)?.lastHeadCheckAt).toBe(
                    failedCheckTime,
                );
            expect(scanner.recheckFromHead(200)).toBe(false);
            expect(lookup).toHaveBeenCalledTimes(
                2 * SYNC_GAP_POLICY.CollectionsPerPass + 1,
            );
        },
    );

    it("advances past a page skipped after selection and resets traversal on restart", () => {
        const h = harness();
        const blocked = Array.from(
            { length: SYNC_GAP_POLICY.CollectionsPerPass },
            seed,
        );
        for (const id of blocked)
            retain(h.store, id, { lastHeadCheckAt: null });
        const target = seed();
        retain(h.store, target, { lastHeadCheckAt: null });
        const original = h.registry.getCollection.bind(h.registry);
        const get = vi
            .spyOn(h.registry, "getCollection")
            .mockImplementation((chainId, id) =>
                blocked.includes(id) ? null : original(chainId, id),
            );
        const scanner = h.scanner();
        expect(scanner.recheckFromHead(200)).toBe(false);
        expect(get).toHaveBeenCalledTimes(SYNC_GAP_POLICY.CollectionsPerPass);
        expect(scanner.recheckFromHead(200)).toBe(true);
        expect(h.store.getProgress(1, target)?.lastHeadCheckAt).toBe(now);
        for (const id of blocked)
            expect(h.store.getProgress(1, id)?.lastHeadCheckAt).toBeNull();
        get.mockRestore();
        expect(h.scanner().recheckFromHead(200)).toBe(true);
        for (const id of blocked)
            expect(h.store.getProgress(1, id)?.lastHeadCheckAt).toBe(now);
    });

    it("finishes a due traversal even when successful rows become due again during it", () => {
        const h = harness();
        const failed = seed(),
            first = seed(),
            second = seed();
        retain(h.store, failed, { lastHeadCheckAt: null });
        for (const id of [first, second])
            retain(h.store, id, { lastHeadCheckAt: 0 });
        const original = h.store.findNewestGap.bind(h.store);
        const visited: number[] = [];
        vi.spyOn(h.store, "findNewestGap").mockImplementation(
            (chainId, id, window, cap) => {
                visited.push(id);
                if (id === failed) throw new Error("persistent read failure");
                return original(chainId, id, window, cap);
            },
        );
        const scanner = new SyncGapScheduler(h.registry, h.store, {
            chainId: 1,
            batchSize: 2,
            collectionsPerPass: 1,
            now: () => now,
        });
        for (let pass = 0; pass < 4; pass++) {
            scanner.recheckFromHead(200);
            now += SYNC_GAP_POLICY.HeadRecheckIntervalMs;
        }
        expect(visited).toEqual([failed, first, second, failed]);
        expect(h.store.getProgress(1, failed)?.lastHeadCheckAt).toBeNull();
    });

    it("rejects stale cross-process saves after a competing cursor or check update", () => {
        const h = harness(),
            id = seed();
        retain(h.store, id);
        const before = h.store.getProgress(1, id)!;
        retain(h.store, id, { cursorBlock: 105, lastHeadCheckAt: now + 1 });
        expect(
            h.store.saveProgress({
                chainId: 1,
                collectionId: id,
                expected: before,
                progress: { ...before, cursorBlock: 120 },
            }),
        ).toBe(false);
        expect(
            h.store.saveProgress({
                chainId: 1,
                collectionId: id,
                expected: null,
                progress: before,
            }),
        ).toBe(false);
        expect(h.store.getProgress(1, id)?.cursorBlock).toBe(105);
    });

    it("does not resurrect a repair completed while a HEAD check was reading coverage", () => {
        const h = harness(),
            id = seed();
        retain(h.store, id, { lastHeadCheckAt: null });
        const before = h.store.getProgress(1, id)!;
        vi.spyOn(h.store, "findNewestGap").mockImplementationOnce(() => {
            h.store.recordRepairProgress({
                chainId: 1,
                repair: {
                    ...before.pending!,
                    collectionId: id,
                    anchorBlock: 100,
                },
                remaining: null,
                retryAt: now,
            });
            return { fromBlock: 199, toBlock: 200 };
        });
        expect(h.scanner().recheckFromHead(200)).toBe(false);
        expect(h.store.getProgress(1, id)?.pending).toBeNull();
        expect(h.store.getProgress(1, id)?.lastHeadCheckAt).toBeNull();
    });

    it("does not let an older scanner overwrite a range saved by the sync worker", async () => {
        const h = harness(),
            id = seed();
        retain(h.store, id, { pending: null });
        vi.spyOn(h.store, "findGap").mockImplementationOnce(() => {
            retain(h.store, id, {
                cursorBlock: 197,
                pending: {
                    repairId: "newer-worker-range",
                    fromBlock: 198,
                    toBlock: 199,
                    retryAt: now,
                },
            });
            return { fromBlock: 100, toBlock: 100 };
        });
        await h.scanner().scan(200);
        expect(h.store.getProgress(1, id)).toMatchObject({
            cursorBlock: 197,
            pending: {
                repairId: "newer-worker-range",
                fromBlock: 198,
                toBlock: 199,
            },
        });
    });

    it("reuses a HEAD check completed by the scheduler after due IDs were selected", () => {
        const h = harness(),
            id = seed();
        retain(h.store, id, { lastHeadCheckAt: null });
        const get = h.registry.getCollection.bind(h.registry);
        vi.spyOn(h.registry, "getCollection").mockImplementationOnce(
            (...args) => {
                retain(h.store, id, { lastHeadCheckAt: now });
                return get(...args);
            },
        );
        const lookup = vi.spyOn(h.store, "findNewestGap");
        expect(h.scanner().recheckFromHead(200)).toBe(false);
        expect(lookup).not.toHaveBeenCalled();
        expect(h.store.getProgress(1, id)?.lastHeadCheckAt).toBe(now);
    });

    it("records ordinary HEAD scans without moving the time during older scanning", async () => {
        const h = harness(),
            id = seed();
        cover(id, 100, 20_100);
        const scanner = h.scanner();
        await scanner.scan(20_100);
        const first = h.store.getProgress(1, id)!;
        expect(first.lastHeadCheckAt).toBe(now);
        now += 1000;
        await scanner.scan(20_100);
        expect(h.store.getProgress(1, id)?.lastHeadCheckAt).toBe(
            first.lastHeadCheckAt,
        );
        expect(h.store.getProgress(1, id)?.cursorBlock).toBeLessThan(
            first.cursorBlock!,
        );
    });

    it("finds the newest contiguous capped hole for every small coverage shape", () => {
        const h = harness(),
            id = seed();
        for (let mask = 0; mask < 64; mask++) {
            db.prepare(
                "DELETE FROM collection_sync_blocks WHERE collection_id=?",
            ).run(id);
            const missing = Array.from({ length: 6 }, (_, i) => 100 + i).filter(
                (_, i) => !(mask & (1 << i)),
            );
            cover(id, 100, 105, missing);
            for (const cap of [1, 2, 6]) {
                const highest = missing.at(-1);
                let lowest = highest;
                if (lowest !== undefined)
                    while (
                        missing.includes(lowest - 1) &&
                        highest! - lowest + 1 < cap
                    )
                        lowest--;
                expect(
                    h.store.findNewestGap(
                        1,
                        id,
                        { fromBlock: 100, toBlock: 105 },
                        cap,
                    ),
                ).toEqual(
                    highest === undefined
                        ? null
                        : { fromBlock: lowest, toBlock: highest },
                );
            }
        }
    });

    it("uses one WAL snapshot for counts and final boundaries while another connection writes", () => {
        const h = harness(),
            id = seed();
        cover(id, 100, 105, [105]);
        const writer = new Database(db.raw.name);
        const find = h.store.findGap.bind(h.store);
        vi.spyOn(h.store, "findGap").mockImplementationOnce((...args) => {
            writer
                .prepare(
                    "INSERT INTO collection_sync_blocks(chain_id,collection_id,block_number) VALUES(1,?,105)",
                )
                .run(id);
            return find(...args);
        });
        try {
            expect(
                h.store.findNewestGap(
                    1,
                    id,
                    { fromBlock: 100, toBlock: 105 },
                    2,
                ),
            ).toEqual({ fromBlock: 105, toBlock: 105 });
            expect(
                h.store.findNewestGap(
                    1,
                    id,
                    { fromBlock: 100, toBlock: 105 },
                    2,
                ),
            ).toBeNull();
        } finally {
            writer.close();
        }
    });
});

function cover(
    collectionId: number,
    from: number,
    to: number,
    missing: number[] = [],
) {
    const skip = new Set(missing);
    const insert = db.prepare(
        "INSERT OR IGNORE INTO collection_sync_blocks(chain_id,collection_id,block_number) VALUES(1,?,?)",
    );
    db.writeTransaction(() => {
        for (let n = from; n <= to; n++)
            if (!skip.has(n)) insert.run(collectionId, n);
    })();
}
