import { beforeEach, describe, expect, it, vi } from "vitest";
import { db, setDbPath } from "@artgod/shared/database";
import { createMigrationRunner } from "@artgod/shared/migrations";
import { COLLECTION_STATUS } from "@artgod/shared/types";
import {
    AutomaticSyncExecutor,
    startAutomaticSyncLoop,
} from "../src/application/automatic-sync-executor.js";
import {
    BackfillExecutionGate,
    BACKFILL_EXECUTION_MODE,
} from "../src/application/backfill-execution.js";
import {
    SyncGapScheduler,
    SYNC_GAP_POLICY,
} from "../src/application/sync-gap-scheduler.js";
import { buildSyncFollowUps } from "../src/application/sync-range-processing.js";
import { REORG_RECOVERY_PHASE } from "../src/domain/reorg-recovery.js";
import { ChainSyncConflict } from "../src/domain/chain-sync.js";
import { SYNC_WORK_COMPLETION } from "../src/domain/sync-work.js";
import { BACKFILL_ORDER_MAINTENANCE_POLICY } from "../src/domain/sync-jobs.js";
import { createTempDbPath } from "./helpers/test-helpers.js";
import { loadTestEnv } from "./helpers/test-env.js";
import {
    insertCollection,
    emptyOnChainData,
    selectBalanceOwners,
    transferFixture,
} from "./helpers/ownership-fixture.js";
import { syncBlockFixture } from "./helpers/chain-fixture.js";
import {
    RecoveryRpc,
    reorgRecoveryServices,
    seedRecoveryHistory,
    pendingRecoveryRange,
    canonicalRecoveryBlock,
    REORG_FIXTURE as F,
} from "./helpers/reorg-recovery-fixture.js";

describe("direct automatic sync execution", () => {
    loadTestEnv();
    let now: number;
    beforeEach(async () => {
        setDbPath(await createTempDbPath());
        await createMigrationRunner().runMigrations();
        now = 1000;
    });

    function services(rpc = new RecoveryRpc(200)) {
        return reorgRecoveryServices(rpc, {
            now: () => now,
            retryDelayMs: 100,
        });
    }
    function scanner(s: ReturnType<typeof services>) {
        return new SyncGapScheduler(s.registry, s.gaps, {
            chainId: 1,
            batchSize: 2,
            now: () => now,
        });
    }
    function retain(
        s: ReturnType<typeof services>,
        collectionId: number,
        fromBlock: number,
        toBlock: number,
    ) {
        s.gaps.saveProgress({
            chainId: 1,
            collectionId,
            expected: s.gaps.getProgress(1, collectionId),
            progress: {
                anchorBlock: 100,
                cursorBlock: fromBlock - 1,
                lastHeadCheckAt: now,
                pending: {
                    repairId: `repair:${collectionId}`,
                    fromBlock,
                    toBlock,
                    retryAt: now,
                },
            },
        });
    }

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

    it("finishes the running range before checking HEAD and replacing older progress", async () => {
        const rpc = new RecoveryRpc(200),
            s = services(rpc),
            f = transferFixture();
        vi.spyOn(rpc, "getBlockNumber").mockResolvedValue(200);
        retain(s, f.collectionId, 101, 102);
        cover(f.collectionId, 103, 200, [199, 200]);
        const old = s.gaps.getProgress(1, f.collectionId)!.pending;
        const entered = Promise.withResolvers<void>(),
            release = Promise.withResolvers<void>();
        let held = false;
        rpc.beforeLogs = async (filter) => {
            if (filter.fromBlock !== 101 || held) return;
            held = true;
            entered.resolve();
            await release.promise;
        };
        const running = s.executor.runDue();
        await entered.promise;
        now += SYNC_GAP_POLICY.HeadRecheckIntervalMs;
        await scanner(s).scan(200);
        expect(s.executor.runDue()).toBe(running);
        expect(s.gaps.getProgress(1, f.collectionId)?.pending).toEqual(old);
        release.resolve();
        await running;
        expect(
            s.storage.countCollectionSyncedBlocksInRange(
                1,
                f.collectionId,
                101,
                102,
            ),
        ).toBe(2);
        expect(s.gaps.getProgress(1, f.collectionId)?.lastHeadCheckAt).toBe(
            1000,
        );
        await s.executor.runDue();
        expect(
            s.storage.countCollectionSyncedBlocksInRange(
                1,
                f.collectionId,
                199,
                200,
            ),
        ).toBe(2);
        expect(s.gaps.getProgress(1, f.collectionId)?.lastHeadCheckAt).toBe(
            now,
        );
        expect(s.gaps.getProgress(1, f.collectionId)?.cursorBlock).toBe(198);
    });

    it("checks HEAD and selects replacement work after waiting for another backfill", async () => {
        const rpc = new RecoveryRpc(200),
            s = services(rpc),
            f = transferFixture();
        vi.spyOn(rpc, "getBlockNumber").mockResolvedValue(200);
        retain(s, f.collectionId, 101, 102);
        cover(f.collectionId, 103, 200, [199, 200]);
        const gate = new BackfillExecutionGate(),
            release = Promise.withResolvers<void>();
        const holder = gate.run(
            BACKFILL_EXECUTION_MODE.SerializedCurrentState,
            () => release.promise,
        );
        const head = vi.spyOn(rpc, "getBlockNumber");
        const executor = new AutomaticSyncExecutor({
            rpc,
            storage: s.storage,
            commit: s.commit,
            gaps: s.gaps,
            headGapRecheck: scanner(s),
            recoveries: s.recoveries,
            collectionsPort: s.registry,
            collectionExtensions: { getInstall: () => null },
            chainId: 1,
            bidderIndex: { isActive: () => false, shouldEmit: () => false },
            wethAddress: F.Weth,
            batchSize: 2,
            gate,
            now: () => now,
        });
        const waiting = executor.runDue();
        await Promise.resolve();
        expect(head).not.toHaveBeenCalled();
        now += SYNC_GAP_POLICY.HeadRecheckIntervalMs;
        release.resolve();
        await holder;
        await waiting;
        expect(
            s.storage.countCollectionSyncedBlocksInRange(
                1,
                f.collectionId,
                101,
                102,
            ),
        ).toBe(0);
        expect(
            s.storage.countCollectionSyncedBlocksInRange(
                1,
                f.collectionId,
                199,
                200,
            ),
        ).toBe(2);
        expect(head).toHaveBeenCalledOnce();
    });

    it("does no RPC polling when idle and executes at most one bounded range per pass", async () => {
        const rpc = new RecoveryRpc(200),
            head = vi.spyOn(rpc, "getBlockNumber"),
            s = services(rpc);
        await s.executor.runDue();
        expect(head).not.toHaveBeenCalled();
        const first = insertCollection({
            chainId: 1,
            slug: "first",
            address: F.Owner,
            anchorBlock: 100,
        });
        const second = insertCollection({
            chainId: 1,
            slug: "second",
            address: F.OrphanOwner,
            anchorBlock: 100,
        });
        retain(s, first, 101, 102);
        retain(s, second, 103, 104);
        await s.executor.runDue();
        expect(
            s.storage.countCollectionSyncedBlocksInRange(1, first, 101, 102),
        ).toBe(2);
        expect(
            s.storage.countCollectionSyncedBlocksInRange(1, second, 103, 104),
        ).toBe(0);
        expect(s.gaps.getProgress(1, second)?.pending).not.toBeNull();
        await s.executor.runDue();
        expect(s.gaps.getProgress(1, second)?.pending).toBeNull();
        expect(head).toHaveBeenCalledTimes(2);
    });

    it("defers a failed batch without starving a different due collection", async () => {
        const rpc = new RecoveryRpc(200),
            s = services(rpc);
        const first = insertCollection({
                chainId: 1,
                slug: "bad",
                address: F.Owner,
                anchorBlock: 100,
            }),
            second = insertCollection({
                chainId: 1,
                slug: "good",
                address: F.OrphanOwner,
                anchorBlock: 100,
            });
        retain(s, first, 105, 106);
        retain(s, second, 101, 102);
        vi.spyOn(rpc, "getLogs").mockRejectedValueOnce(
            new Error("provider unavailable"),
        );
        await s.executor.runDue();
        expect(s.gaps.getProgress(1, first)?.pending?.retryAt).toBe(1100);
        await s.executor.runDue();
        expect(s.gaps.getProgress(1, second)?.pending).toBeNull();
        expect(s.gaps.getProgress(1, first)?.pending).not.toBeNull();
        now += 100;
        await s.executor.runDue();
        expect(s.gaps.getProgress(1, first)?.pending).toBeNull();
    });

    it("coalesces polling and drains admitted work before shutdown", async () => {
        const rpc = new RecoveryRpc(200),
            s = services(rpc),
            f = transferFixture();
        retain(s, f.collectionId, 101, 102);
        const entered = Promise.withResolvers<void>(),
            release = Promise.withResolvers<void>();
        rpc.beforeLogs = async () => {
            entered.resolve();
            await release.promise;
        };
        const first = s.executor.runDue();
        expect(s.executor.runDue()).toBe(first);
        await entered.promise;
        const stop = startAutomaticSyncLoop(s.executor, 10);
        let stopped = false;
        const stopping = stop().then(() => {
            stopped = true;
        });
        await Promise.resolve();
        expect(stopped).toBe(false);
        release.resolve();
        await stopping;
        expect(stopped).toBe(true);
        expect(s.gaps.getProgress(1, f.collectionId)?.pending).toBeNull();
        const reads = rpc.logReads;
        await new Promise((resolve) => setTimeout(resolve, 30));
        expect(rpc.logReads).toBe(reads);
    });

    it.each(["pause", "anchor", "purge"])(
        "rejects all writes when a gap member changes by %s during RPC",
        async (change) => {
            const rpc = new RecoveryRpc(200),
                s = services(rpc),
                f = transferFixture();
            retain(s, f.collectionId, 101, 102);
            let changed = false;
            rpc.beforeLogs = async () => {
                if (changed) return;
                changed = true;
                if (change === "pause")
                    db.prepare(
                        "UPDATE collections SET status = ? WHERE collection_id = ?",
                    ).run(COLLECTION_STATUS.Paused, f.collectionId);
                if (change === "anchor")
                    db.prepare(
                        "UPDATE collections SET bootstrap_anchor_block = 101 WHERE collection_id = ?",
                    ).run(f.collectionId);
                if (change === "purge")
                    db.prepare(
                        "DELETE FROM collections WHERE collection_id = ?",
                    ).run(f.collectionId);
            };
            await s.executor.runDue();
            expect(
                s.storage.countCollectionSyncedBlocksInRange(
                    1,
                    f.collectionId,
                    101,
                    102,
                ),
            ).toBe(0);
            expect(
                db.prepare("SELECT COUNT(*) AS count FROM queue_outbox").get(),
            ).toEqual({ count: 0 });
            expect(s.storage.getBlockHash(1, 101)).toBeNull();
        },
    );

    it("reloads gap eligibility after waiting for the current-state gate", async () => {
        const rpc = new RecoveryRpc(200),
            s = services(rpc),
            f = transferFixture();
        retain(s, f.collectionId, 101, 102);
        const gate = new BackfillExecutionGate(),
            release = Promise.withResolvers<void>();
        const holder = gate.run(
            BACKFILL_EXECUTION_MODE.SerializedCurrentState,
            () => release.promise,
        );
        const executor = new AutomaticSyncExecutor({
            rpc,
            storage: s.storage,
            commit: s.commit,
            gaps: s.gaps,
            headGapRecheck: scanner(s),
            recoveries: s.recoveries,
            collectionsPort: s.registry,
            collectionExtensions: { getInstall: () => null },
            chainId: 1,
            bidderIndex: { isActive: () => false, shouldEmit: () => false },
            wethAddress: F.Weth,
            batchSize: 2,
            gate,
            now: () => now,
        });
        const running = executor.runDue();
        await Promise.resolve();
        db.prepare(
            "UPDATE collections SET status = ? WHERE collection_id = ?",
        ).run(COLLECTION_STATUS.Paused, f.collectionId);
        release.resolve();
        await holder;
        await running;
        expect(rpc.logReads).toBe(0);
        expect(s.gaps.getProgress(1, f.collectionId)?.pending).not.toBeNull();
    });

    it("rolls back facts, balance, coverage and required publications when advancing gap progress fails", () => {
        const s = services(),
            f = transferFixture();
        retain(s, f.collectionId, 101, 102);
        const repair = s.gaps.listDuePage({
            chainId: 1,
            now,
            limit: 1,
            after: null,
        }).repairs[0];
        const data = emptyOnChainData();
        data.collectionScoped.nftTransferEvents.push(
            f.transfer(102, 1, F.Owner, F.OrphanOwner),
        );
        const result = {
            checkpoint: s.storage.captureSyncCheckpoint(1),
            blocks: [101, 102].map(syncBlockFixture),
            data,
            collections: [s.registry.getCollection(1, f.collectionId)!],
        };
        const followUps = buildSyncFollowUps(
            1,
            result.collections,
            { fromBlock: 101, toBlock: 102 },
            [
                {
                    fanoutId: repair.repairId,
                    sourceJobId: repair.repairId,
                    sourceKind: "fixture",
                },
            ],
            "backfill",
            data,
            BACKFILL_ORDER_MAINTENANCE_POLICY.CurrentState,
        );
        db.exec(
            "CREATE TEMP TRIGGER fail_gap_progress BEFORE UPDATE ON collection_sync_gap_scans WHEN NEW.pending_job_id IS NULL BEGIN SELECT RAISE(ABORT, 'progress unavailable'); END;",
        );
        expect(() =>
            s.commit.commitSyncRange({
                result,
                followUps,
                completion: {
                    kind: SYNC_WORK_COMPLETION.GapRepair,
                    batch: { fromBlock: 101, toBlock: 102, repairs: [repair] },
                    retryAt: now,
                },
            }),
        ).toThrow("progress unavailable");
        expect(selectBalanceOwners(1, f.collectionId, "1")).toEqual([]);
        expect(s.storage.getBlockHash(1, 101)).toBeNull();
        expect(s.gaps.getProgress(1, f.collectionId)?.pending?.repairId).toBe(
            repair.repairId,
        );
        expect(
            db.prepare("SELECT COUNT(*) AS count FROM queue_outbox").get(),
        ).toEqual({ count: 0 });
    });

    it("rolls back a shared acquisition after the second member's progress write fails", async () => {
        const s = services(),
            first = insertCollection({
                chainId: 1,
                slug: "first-member",
                address: F.Owner,
                anchorBlock: 100,
            }),
            second = insertCollection({
                chainId: 1,
                slug: "second-member",
                address: F.OrphanOwner,
                anchorBlock: 100,
            });
        retain(s, first, 101, 102);
        retain(s, second, 101, 102);
        db.exec(
            `CREATE TEMP TRIGGER fail_second_member BEFORE UPDATE ON collection_sync_gap_scans WHEN NEW.collection_id = ${second} AND NEW.pending_job_id IS NULL BEGIN SELECT RAISE(ABORT, 'member progress unavailable'); END;`,
        );
        await s.executor.runDue();
        for (const id of [first, second]) {
            expect(
                s.storage.countCollectionSyncedBlocksInRange(1, id, 101, 102),
            ).toBe(0);
            expect(s.gaps.getProgress(1, id)?.pending).toMatchObject({
                fromBlock: 101,
                toBlock: 102,
                retryAt: 1100,
            });
        }
        expect(
            db.prepare("SELECT COUNT(*) AS count FROM queue_outbox").get(),
        ).toEqual({ count: 0 });
        db.exec("DROP TRIGGER fail_second_member;");
        now += 100;
        await s.executor.runDue();
        for (const id of [first, second])
            expect(s.gaps.getProgress(1, id)?.pending).toBeNull();
    });

    it("does not complete a gap from an incomplete header result", () => {
        const s = services(),
            f = transferFixture();
        retain(s, f.collectionId, 101, 102);
        const repair = s.gaps.listDuePage({
            chainId: 1,
            now,
            limit: 1,
            after: null,
        }).repairs[0];
        expect(() =>
            s.commit.commitSyncRange({
                result: {
                    checkpoint: s.storage.captureSyncCheckpoint(1),
                    blocks: [syncBlockFixture(102)],
                    data: emptyOnChainData(),
                    collections: [s.registry.getCollection(1, f.collectionId)!],
                },
                followUps: [],
                completion: {
                    kind: SYNC_WORK_COMPLETION.GapRepair,
                    batch: { fromBlock: 101, toBlock: 102, repairs: [repair] },
                    retryAt: now,
                },
            }),
        ).toThrow(ChainSyncConflict);
        expect(s.gaps.getProgress(1, f.collectionId)?.pending).not.toBeNull();
        expect(s.storage.getBlockHash(1, 102)).toBeNull();
    });

    it("prioritizes retained resync and atomically rolls back acquisition if continuation storage fails", async () => {
        const s = services(new RecoveryRpc());
        const f = seedRecoveryHistory();
        await s.recovery.checkBlock(F.Orphan);
        const range = pendingRecoveryRange();
        retain(s, f.collectionId, 101, 102);
        db.exec(
            "CREATE TEMP TRIGGER fail_resync_progress BEFORE UPDATE ON chain_reorg_recoveries WHEN NEW.range_from > OLD.range_from BEGIN SELECT RAISE(ABORT, 'continuation unavailable'); END;",
        );
        await s.executor.runDue();
        expect(pendingRecoveryRange()).toEqual(range);
        expect(s.storage.getBlockHash(1, F.Orphan)).toBeNull();
        expect(
            db.prepare("SELECT COUNT(*) AS count FROM queue_outbox").get(),
        ).toEqual({ count: 0 });
        expect(s.gaps.getProgress(1, f.collectionId)?.pending).not.toBeNull();
        db.exec("DROP TRIGGER fail_resync_progress;");
        now += 100;
        await s.executor.runDue();
        expect(pendingRecoveryRange()).toMatchObject({
            fromBlock: 107,
            toBlock: 107,
        });
    });

    it("rejects acquisition after an earlier mismatch replaces its recovery during RPC", async () => {
        const rpc = new RecoveryRpc(),
            s = services(rpc),
            f = seedRecoveryHistory();
        await s.recovery.checkBlock(F.Orphan);
        const old = pendingRecoveryRange();
        const original = rpc.getBlock.bind(rpc);
        let newer = false;
        rpc.getBlock = async (number) =>
            newer ? canonicalRecoveryBlock(number, 103) : original(number);
        rpc.beforeLogs = async () => {
            if (newer) return;
            newer = true;
            await s.recovery.checkBlock(104);
        };
        await s.executor.runDue();
        expect(s.recoveries.getRecovery(1)).toMatchObject({
            phase: REORG_RECOVERY_PHASE.AwaitingAncestor,
            checkedBlock: 104,
            revision: 1,
        });
        expect(s.recoveries.getRecovery(1)!.recoveryId).not.toBe(
            old.recoveryId,
        );
        expect(
            s.storage.countCollectionSyncedBlocksInRange(
                1,
                f.collectionId,
                105,
                106,
            ),
        ).toBe(0);
        expect(
            db.prepare("SELECT COUNT(*) AS count FROM queue_outbox").get(),
        ).toEqual({ count: 0 });
    });

    it("retains gap intent above a temporarily shortened head without acquiring it", async () => {
        const rpc = new RecoveryRpc(200),
            s = services(rpc),
            f = transferFixture();
        retain(s, f.collectionId, 106, 107);
        vi.spyOn(rpc, "getBlockNumber").mockResolvedValue(105);
        await s.executor.runDue();
        expect(rpc.logReads).toBe(0);
        expect(s.gaps.getProgress(1, f.collectionId)?.pending).toMatchObject({
            fromBlock: 106,
            toBlock: 107,
        });
        await scanner(s).scan(105);
        expect(s.gaps.getProgress(1, f.collectionId)?.pending).toMatchObject({
            fromBlock: 106,
            toBlock: 107,
        });
    });
    it.each([false, true])(
        "passes one above-head page per poll and reaches eligible history (restart=%s)",
        async (restart) => {
            const rpc = new RecoveryRpc(200),
                s = services(rpc),
                head = vi.spyOn(rpc, "getBlockNumber").mockResolvedValue(107);
            const blocked = Array.from({ length: 16 }, (_, index) => {
                const id = insertCollection({
                    chainId: 1,
                    slug: `above-head-${index}`,
                    address: `0x${(index + 1).toString(16).padStart(40, "0")}`,
                    anchorBlock: 100,
                });
                retain(s, id, 108, 110);
                return id;
            });
            const eligible = insertCollection({
                chainId: 1,
                slug: "eligible-after-page",
                address: F.Owner,
                anchorBlock: 100,
            });
            retain(s, eligible, 101, 102);
            let executor = s.executor;
            await executor.runDue();
            expect(rpc.logReads).toBe(0);
            if (restart) {
                executor = services(rpc).executor;
                await executor.runDue();
                expect(rpc.logReads).toBe(0);
            }
            await executor.runDue();
            expect(s.gaps.getProgress(1, eligible)?.pending).toBeNull();
            expect(
                s.storage.countCollectionSyncedBlocksInRange(
                    1,
                    eligible,
                    101,
                    102,
                ),
            ).toBe(2);
            expect(head).toHaveBeenCalledTimes(restart ? 3 : 2);
            for (const id of blocked)
                expect(s.gaps.getProgress(1, id)?.pending).toEqual({
                    repairId: `repair:${id}`,
                    fromBlock: 108,
                    toBlock: 110,
                    retryAt: now,
                });
        },
    );

    it("seeks a bounded retry-ordered page through a larger retained backlog", () => {
        const s = services();
        const ids: number[] = [];
        db.writeTransaction(() => {
            for (let index = 0; index < 4096; index++) {
                const id = insertCollection({
                    chainId: 1,
                    slug: `pending-${index}`,
                    address: `0x${(index + 1).toString(16).padStart(40, "0")}`,
                    anchorBlock: 100,
                });
                retain(s, id, 108, 110);
                ids.push(id);
            }
        })();
        const page = s.gaps.listDuePage({
            chainId: 1,
            now,
            limit: 16,
            after: { retryAt: now, collectionId: ids[4079] },
        });
        expect(page.repairs.map((repair) => repair.collectionId)).toEqual(
            ids.slice(4080),
        );
        expect(page.cursor).toEqual({ retryAt: now, collectionId: ids[4095] });
        expect(
            s.gaps.listDuePage({
                chainId: 1,
                now,
                limit: 16,
                after: page.cursor,
            }).repairs,
        ).toEqual([]);
        expect(
            s.gaps
                .listDuePage({ chainId: 1, now, limit: 16, after: null })
                .repairs.map((repair) => repair.collectionId),
        ).toEqual(ids.slice(0, 16));
    });
});
