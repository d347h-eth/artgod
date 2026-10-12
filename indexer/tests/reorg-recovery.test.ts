import { retainCanonicalCheckFixture } from "./helpers/reorg-recovery-fixture.js";
import { FINALIZED_SYNC_CHECK_POLICY } from "./helpers/chain-fixture.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { db, setDbPath } from "@artgod/shared/database";
import { logger } from "@artgod/shared/utils";
import { createMigrationRunner } from "@artgod/shared/migrations";
import { COLLECTION_STATUS } from "@artgod/shared/types";
import { processSyncRange } from "../src/application/sync-range-processing.js";
import { SYNC_WORK_COMPLETION } from "../src/domain/sync-work.js";
import { startReorgRecoveryLoop } from "../src/application/reorg-recovery.js";
import { SyncGapScheduler } from "../src/application/sync-gap-scheduler.js";
import { drainQueueOutbox } from "../src/application/queue-outbox/drainer.js";
import { runWorker } from "../src/application/worker-runner.js";
import { ChainSyncConflict } from "../src/domain/chain-sync.js";
import { planSyncGapRepairBatches } from "../src/domain/sync-gap-repair.js";
import {
    REORG_RECOVERY_PHASE,
    REORG_RECOVERY_LOG_COMPONENT,
    REORG_RECOVERY_LOG_ACTION,
    type ReorgResyncRange,
} from "../src/domain/reorg-recovery.js";
import { QUEUE_OUTBOX_STATUS } from "../src/domain/queue-outbox.js";
import {
    SYNC_JOB_KIND,
    BACKFILL_SOURCE,
    BACKFILL_ORDER_MAINTENANCE_POLICY,
    type BackfillSyncPayload,
} from "../src/domain/sync-jobs.js";
import { QUEUE_NAMES, type QueueName } from "../src/domain/queues.js";
import type { JobEnvelope } from "../src/domain/jobs.js";
import type { QueueMessage, QueuePort } from "../src/ports/queue.js";
import { SqliteSyncGapStore } from "../src/infra/storage/sqlite-sync-gaps.js";
import { SqliteBootstrapStorage } from "../src/infra/bootstrap/sqlite.js";
import { syncBlockFixture } from "./helpers/chain-fixture.js";
import { createTempDbPath } from "./helpers/test-helpers.js";
import { loadTestEnv } from "./helpers/test-env.js";
import {
    emptyOnChainData,
    selectBalanceOwners,
    selectTransferCount,
} from "./helpers/ownership-fixture.js";
import {
    REORG_FIXTURE as F,
    RecoveryRpc,
    reorgRecoveryServices,
    seedRecoveryHistory,
    pendingRecoveryRange,
    canonicalRecoveryBlock,
} from "./helpers/reorg-recovery-fixture.js";

class RecordingQueue implements QueuePort {
    jobs: JobEnvelope<unknown>[] = [];
    failureQueue?: QueueName;
    handler?: (message: QueueMessage<unknown>) => Promise<void>;
    async publish<T>(queue: QueueName, job: JobEnvelope<T>) {
        if (queue === this.failureQueue)
            throw new Error("Publication unavailable");
        this.jobs.push(job);
    }
    async subscribe<T>(
        _queue: QueueName,
        handler: (message: QueueMessage<T>) => Promise<void>,
    ) {
        this.handler = handler as (
            message: QueueMessage<unknown>,
        ) => Promise<void>;
        return async () => {};
    }
    async close() {}
}

describe("durable production reorg recovery", () => {
    loadTestEnv();
    let dbPath: string;
    let now: number;
    let rpc: RecoveryRpc;
    let services: ReturnType<typeof reorgRecoveryServices>;
    let queue: RecordingQueue;
    const retryDelayMs = 100;
    beforeEach(async () => {
        dbPath = await createTempDbPath();
        setDbPath(dbPath);
        await createMigrationRunner().runMigrations();
        now = Date.now();
        rpc = new RecoveryRpc();
        services = reorgRecoveryServices(rpc, { now: () => now, retryDelayMs });
        queue = new RecordingQueue();
    });
    afterEach(() => vi.restoreAllMocks());
    function reopen() {
        setDbPath(dbPath);
        services = reorgRecoveryServices(rpc, { now: () => now, retryDelayMs });
    }
    async function acquireAndPublish(range: ReorgResyncRange) {
        const completed = await services.acquireRecoveryRange(range);
        await services.publishRetained(queue);
        return completed;
    }
    function revision() {
        return services.storage.captureSyncCheckpoint(F.ChainId).revision;
    }
    function owners(collectionId: number) {
        return selectBalanceOwners(F.ChainId, collectionId, "1");
    }

    it("retains a pending DB check across retention failure and restart", async () => {
        seedRecoveryHistory();
        const warn = vi.spyOn(logger, "warn").mockImplementation(() => {});
        const info = vi.spyOn(logger, "info").mockImplementation(() => {});
        const check = retainCanonicalCheckFixture(services.storage, F.Orphan);
        db.exec(
            "CREATE TEMP TRIGGER fail_mismatch_retention BEFORE INSERT ON chain_reorg_recoveries BEGIN SELECT RAISE(ABORT,'journal unavailable'); END;",
        );
        await services.recovery.checkBlock(check);
        expect(services.recoveries.getRecovery(1)).toBeNull();
        expect(services.checks.hasPending(1, now)).toBe(false);
        expect(warn).not.toHaveBeenCalledWith(
            expect.any(String),
            expect.objectContaining({
                action: REORG_RECOVERY_LOG_ACTION.MismatchRetained,
            }),
        );
        expect(info).not.toHaveBeenCalledWith(
            expect.any(String),
            expect.objectContaining({
                action: REORG_RECOVERY_LOG_ACTION.RollbackCommitted,
            }),
        );
        db.exec("DROP TRIGGER fail_mismatch_retention;");
        now += retryDelayMs;
        reopen();
        expect(await services.recovery.checkDue()).toBe(true);
        expect(revision()).toBe(1);
        expect(services.recoveries.getRecovery(1)?.phase).toBe(
            REORG_RECOVERY_PHASE.Resync,
        );
        const recoveryId = services.recoveries.getRecovery(1)!.recoveryId;
        expect(warn).toHaveBeenCalledWith(
            expect.any(String),
            expect.objectContaining({
                component: REORG_RECOVERY_LOG_COMPONENT,
                action: REORG_RECOVERY_LOG_ACTION.MismatchRetained,
                chainId: F.ChainId,
                recoveryId,
                checkedBlock: F.Orphan,
                storedHash: check.blockHash,
                observedHash: canonicalRecoveryBlock(F.Orphan).hash,
                revision: 0,
            }),
        );
        expect(info).toHaveBeenCalledWith(
            expect.any(String),
            expect.objectContaining({
                component: REORG_RECOVERY_LOG_COMPONENT,
                action: REORG_RECOVERY_LOG_ACTION.RollbackCommitted,
                recoveryId,
                checkedBlock: F.Orphan,
                storedHash: check.blockHash,
                observedHash: canonicalRecoveryBlock(F.Orphan).hash,
                forkBlock: F.Fork,
                forkHash: canonicalRecoveryBlock(F.Fork).hash,
                forkToCheckedBlocks: F.Orphan - F.Fork,
                rollbackFromBlock: F.Fork + 1,
                capturedHeadBlock: F.Head,
                resyncFromBlock: F.Fork + 1,
                resyncToBlock: F.Head,
                resyncBlocks: F.Head - F.Fork,
                firstBatchToBlock: F.Fork + F.BatchSize,
                batchSize: F.BatchSize,
                affectedErc721Tokens: 1,
                revisionBefore: 0,
                revisionAfter: 1,
            }),
        );
        expect(queue.jobs).toHaveLength(0);
    });

    it.each(["rpc", "wrong-height", "checkpoint-read", "header-read"] as const)(
        "retains DB ownership after repeated journal failures followed by %s failure",
        async (failure) => {
            const fixture = seedRecoveryHistory();
            const check = retainCanonicalCheckFixture(
                services.storage,
                F.Orphan,
            );
            db.exec(
                "CREATE TEMP TRIGGER fail_mismatch_retention BEFORE INSERT ON chain_reorg_recoveries BEGIN SELECT RAISE(ABORT,'journal unavailable'); END;",
            );
            for (let attempt = 0; attempt < 5; attempt++) {
                await services.recovery.checkBlock(check);
                now += retryDelayMs;
            }
            db.exec("DROP TRIGGER fail_mismatch_retention;");
            switch (failure) {
                case "rpc":
                    vi.spyOn(rpc, "getBlock").mockRejectedValueOnce(
                        new Error("RPC unavailable"),
                    );
                    break;
                case "wrong-height":
                    vi.spyOn(rpc, "getBlock").mockResolvedValueOnce(
                        canonicalRecoveryBlock(F.Orphan + 1),
                    );
                    break;
                case "checkpoint-read":
                    vi.spyOn(
                        services.storage,
                        "captureSyncCheckpoint",
                    ).mockImplementationOnce(() => {
                        throw new Error("Checkpoint unavailable");
                    });
                    break;
                case "header-read":
                    vi.spyOn(
                        services.storage,
                        "getBlockHash",
                    ).mockImplementationOnce(() => {
                        throw new Error("Stored header unavailable");
                    });
                    break;
            }
            await services.recovery.checkBlock(check);
            expect(services.recoveries.getRecovery(1)).toBeNull();
            expect(services.checks.hasPending(1, now + retryDelayMs)).toBe(
                true,
            );
            expect(revision()).toBe(0);
            expect(owners(fixture.collectionId)).toEqual([
                { owner: F.OrphanOwner, amount: "1" },
            ]);
            now += retryDelayMs;
            expect(await services.recovery.checkDue()).toBe(true);
            let ranges = 0;
            while (services.recoveries.getRecovery(1)) {
                expect(await acquireAndPublish(pendingRecoveryRange())).toBe(
                    true,
                );
                expect(++ranges).toBeLessThanOrEqual(2);
            }
            expect(ranges).toBe(2);
            expect(revision()).toBe(1);
            expect(owners(fixture.collectionId)).toEqual([
                { owner: F.Owner, amount: "1" },
            ]);
            expect(selectTransferCount(1, fixture.collectionId, "1")).toBe(0);
            expect(
                services.storage.countCollectionSyncedBlocksInRange(
                    1,
                    fixture.collectionId,
                    F.Orphan,
                    F.Head,
                ),
            ).toBe(3);
        },
    );

    it("retains recovery after a post-handoff continuation and retry-bookkeeping failure", async () => {
        const fixture = seedRecoveryHistory();
        const check = retainCanonicalCheckFixture(services.storage, F.Orphan);
        vi.spyOn(rpc, "readContractAtBlock").mockRejectedValueOnce(
            new Error("Ownership RPC unavailable"),
        );
        vi.spyOn(services.recoveries, "deferProof").mockImplementationOnce(
            () => {
                throw new Error("Retry bookkeeping unavailable");
            },
        );
        await expect(services.recovery.checkBlock(check)).rejects.toThrow(
            "Retry bookkeeping unavailable",
        );
        expect(services.recoveries.getRecovery(1)?.phase).toBe(
            REORG_RECOVERY_PHASE.AwaitingAncestor,
        );
        expect(services.checks.hasPending(1, now)).toBe(false);
        await services.recovery.resumeDue();
        expect(revision()).toBe(1);
        expect(owners(fixture.collectionId)).toEqual([
            { owner: F.Owner, amount: "1" },
        ]);
    });

    it("does not let a repaired header hide an earlier orphan when choosing the rollback boundary", async () => {
        const forkBlock = 102;
        const fixture = seedRecoveryHistory(false);
        fixture.persist([
            {
                ...fixture.transfer(103, 1, F.Owner, F.OrphanOwner),
                tokenId: "2",
            },
        ]);
        rpc = new RecoveryRpc(forkBlock);
        reopen();
        const gaps = new SqliteSyncGapStore();
        const scheduler = new SyncGapScheduler(services.registry, gaps, {
            chainId: F.ChainId,
            batchSize: F.BatchSize,
            now: () => now,
        });
        async function repairNext(expected: number[]) {
            await scheduler.scan(F.Orphan);
            const batch = planSyncGapRepairBatches(
                gaps
                    .listDueRepairsAtNewestPendingHeight({
                        upperBound: Number.MAX_SAFE_INTEGER,
                        chainId: F.ChainId,
                        now,
                        limit: 16,
                    })
                    .map((repair) => ({ repair, missing: repair })),
                F.BatchSize,
            )[0];
            expect([batch.fromBlock, batch.toBlock]).toEqual(expected);
            await services.executor.runDue();
            await services.publishRetained(queue);
        }
        await services.recovery.checkBlock(
            retainCanonicalCheckFixture(services.storage, F.Orphan),
        );
        expect(services.recoveries.getRecovery(F.ChainId)?.phase).toBe(
            REORG_RECOVERY_PHASE.AwaitingAncestor,
        );

        // Startup now repairs the newest eligible hole (106) before older work.
        await services.executor.runDue();
        expect(services.storage.getBlockHash(F.ChainId, 106)).toBe(
            canonicalRecoveryBlock(106, forkBlock).hash,
        );
        // Descending collection repair then inserts canonical 104 between orphan
        // 103 and 105. This matching island is above the genuine fork at 102.
        await repairNext([104, 104]);
        now += retryDelayMs;
        await services.recovery.resumeDue();
        expect(revision()).toBe(0);
        expect(services.recoveries.getRecovery(F.ChainId)?.phase).toBe(
            REORG_RECOVERY_PHASE.AwaitingAncestor,
        );
        expect(services.storage.getBlockHash(F.ChainId, 103)).toBe(
            syncBlockFixture(103).hash,
        );

        await repairNext([101, 102]);
        now += retryDelayMs;
        reopen();
        await services.recovery.resumeDue();
        expect(revision()).toBe(1);
        expect(
            db
                .prepare(
                    "SELECT token_id, block_number FROM erc721_ownership_checkpoints ORDER BY token_id",
                )
                .all(),
        ).toEqual([
            { token_id: "1", block_number: forkBlock },
            { token_id: "2", block_number: forkBlock },
        ]);
        const ranges: number[][] = [];
        while (services.recoveries.getRecovery(F.ChainId)) {
            const job = pendingRecoveryRange();
            ranges.push([job.fromBlock, job.toBlock]);
            expect(await acquireAndPublish(job)).toBe(true);
            expect(ranges.length).toBeLessThanOrEqual(3);
        }
        expect(ranges).toEqual([
            [103, 104],
            [105, 106],
            [107, 107],
        ]);
        for (const tokenId of ["1", "2"]) {
            expect(
                selectBalanceOwners(F.ChainId, fixture.collectionId, tokenId),
            ).toEqual([{ owner: F.Owner, amount: "1" }]);
            expect(
                selectTransferCount(F.ChainId, fixture.collectionId, tokenId),
            ).toBe(0);
        }
        for (const number of [103, 104, 105])
            expect(services.storage.getBlockHash(F.ChainId, number)).toBe(
                canonicalRecoveryBlock(number, forkBlock).hash,
            );
        expect(
            services.storage.countCollectionSyncedBlocksInRange(
                F.ChainId,
                fixture.collectionId,
                F.Anchor,
                F.Head,
            ),
        ).toBe(8);
        const completedGaps = new SqliteSyncGapStore();
        expect(
            completedGaps.findGap(
                F.ChainId,
                fixture.collectionId,
                { fromBlock: F.Anchor, toBlock: F.Head },
                F.BatchSize,
            ),
        ).toBeNull();
        expect(
            completedGaps.getProgress(F.ChainId, fixture.collectionId)?.pending,
        ).toBeNull();
        for (const queueName of [
            QUEUE_NAMES.ActivityDomain,
            QUEUE_NAMES.OrdersDomain,
            QUEUE_NAMES.MetadataDomain,
        ]) {
            const publishedRanges = queue.jobs
                .filter((job) => job.queue === queueName)
                .map((job) => {
                    const payload = job.payload as {
                        fromBlock: number;
                        toBlock: number;
                    };
                    return [payload.fromBlock, payload.toBlock];
                });
            expect(publishedRanges).toEqual(expect.arrayContaining(ranges));
        }
    });

    it.each([false, true])(
        "rejects ancestor proof if a lower header appears during ownership reads (divergent=%s)",
        async (divergent) => {
            const fixture = seedRecoveryHistory();
            rpc.beforeOwnerRead = async () => {
                rpc.beforeOwnerRead = undefined;
                const header = syncBlockFixture(divergent ? 10_103 : 103);
                fixture.storage.persistSyncResult({
                    canonicalCheck: FINALIZED_SYNC_CHECK_POLICY,
                    checkpoint: fixture.storage.captureSyncCheckpoint(
                        F.ChainId,
                    ),
                    blocks: [{ ...header, number: 103, timestamp: 103 }],
                    data: emptyOnChainData(),
                    collections: [
                        services.registry.getCollection(
                            F.ChainId,
                            fixture.collectionId,
                        )!,
                    ],
                });
            };
            await services.recovery.checkBlock(
                retainCanonicalCheckFixture(services.storage, F.Orphan),
            );
            expect(revision()).toBe(0);
            expect(owners(fixture.collectionId)).toEqual([
                { owner: F.OrphanOwner, amount: "1" },
            ]);
            expect(services.recoveries.getRecovery(F.ChainId)?.phase).toBe(
                REORG_RECOVERY_PHASE.AwaitingAncestor,
            );
            expect(
                db
                    .prepare("SELECT last_error FROM chain_reorg_recoveries")
                    .get(),
            ).toEqual({
                last_error: expect.stringContaining("ancestor history changed"),
            });
            expect(
                db
                    .prepare(
                        "SELECT COUNT(*) AS count FROM erc721_ownership_checkpoints",
                    )
                    .get(),
            ).toEqual({ count: 0 });
            expect(
                db.prepare("SELECT COUNT(*) AS count FROM queue_outbox").get(),
            ).toEqual({ count: 0 });
            if (!divergent) {
                now += retryDelayMs;
                await services.recovery.resumeDue();
                expect(revision()).toBe(1);
            }
        },
    );

    it("hands off the DB check to retained recovery, fills missing ancestors through actual gap processing, then recovers at stationary HEAD after reopen", async () => {
        const fixture = seedRecoveryHistory(false);
        await services.recovery.checkBlock(
            retainCanonicalCheckFixture(services.storage, F.Orphan),
        );
        expect(services.recoveries.getRecovery(1)).toMatchObject({
            phase: REORG_RECOVERY_PHASE.AwaitingAncestor,
            checkedBlock: F.Orphan,
        });
        expect(owners(fixture.collectionId)).toEqual([
            { owner: F.OrphanOwner, amount: "1" },
        ]);
        expect(revision()).toBe(0);
        reopen();
        const gaps = new SqliteSyncGapStore();
        const scheduler = new SyncGapScheduler(services.registry, gaps, {
            chainId: 1,
            batchSize: F.BatchSize,
            now: () => now,
        });
        vi.spyOn(rpc, "getBlockNumber").mockResolvedValue(F.Head + 1);
        const repaired: number[][] = [];
        for (let i = 0; i < 3; i++) {
            await scheduler.scan(F.Head);
            const batch = planSyncGapRepairBatches(
                gaps
                    .listDueRepairsAtNewestPendingHeight({
                        upperBound: Number.MAX_SAFE_INTEGER,
                        chainId: 1,
                        now,
                        limit: 16,
                    })
                    .map((repair) => ({ repair, missing: repair })),
                F.BatchSize,
            )[0];
            repaired.push([batch.fromBlock, batch.toBlock]);
            await services.executor.runDue();
            await services.publishRetained(queue);
        }
        expect(repaired).toEqual([
            [106, 107],
            [103, 104],
            [101, 102],
        ]);
        expect(
            services.storage.countCollectionSyncedBlocksInRange(
                1,
                fixture.collectionId,
                100,
                107,
            ),
        ).toBe(8);
        // No new HEAD or broker check: startup continuation alone retries proof.
        now += retryDelayMs;
        reopen();
        const stopRecovery = startReorgRecoveryLoop(services.recovery);
        await stopRecovery();
        expect(revision()).toBe(1);
        expect(owners(fixture.collectionId)).toEqual([
            { owner: F.Owner, amount: "1" },
        ]);
        expect(selectTransferCount(1, fixture.collectionId, "1")).toBe(0);
        expect(pendingRecoveryRange()).toMatchObject({
            fromBlock: 105,
            toBlock: 106,
        });
        while (services.recoveries.getRecovery(1)) {
            const job = pendingRecoveryRange();
            await drainQueueOutbox(services.outbox, queue);
            expect(await acquireAndPublish(job)).toBe(true);
        }
        expect(
            services.storage.countCollectionSyncedBlocksInRange(
                1,
                fixture.collectionId,
                100,
                107,
            ),
        ).toBe(8);
        expect(
            await services.acquireRecoveryRange({
                chainId: 1,
                recoveryId: "completed-recovery",
                revision: 1,
                fromBlock: 105,
                toBlock: 106,
            }),
        ).toBe(false);
    });

    it("unknown ownership failure retains proof without rollback; matching checks have no recovery", async () => {
        const fixture = seedRecoveryHistory();
        await services.recovery.checkBlock(
            retainCanonicalCheckFixture(services.storage, F.Fork),
        );
        expect(services.recoveries.getRecovery(1)).toBeNull();
        rpc.beforeOwnerRead = async () => {
            throw new Error("Historical state unavailable");
        };
        await services.recovery.checkBlock(
            retainCanonicalCheckFixture(services.storage, F.Orphan),
        );
        expect(revision()).toBe(0);
        expect(owners(fixture.collectionId)).toEqual([
            { owner: F.OrphanOwner, amount: "1" },
        ]);
        expect(
            db.prepare("SELECT last_error FROM chain_reorg_recoveries").get(),
        ).toEqual({
            last_error: expect.stringContaining("Historical state unavailable"),
        });
        await services.recovery.resumeDue();
        expect(rpc.ownerReads).toHaveLength(1); // Retry eligibility avoids a hot loop.
        reopen();
        rpc.beforeOwnerRead = undefined;
        now += retryDelayMs;
        await services.recovery.resumeDue();
        expect(revision()).toBe(1);
        expect(owners(fixture.collectionId)).toEqual([
            { owner: F.Owner, amount: "1" },
        ]);
    });

    it("defers a head behind the verified fork and completes fork-only rollback without an invented range", async () => {
        const fixture = seedRecoveryHistory();
        const info = vi.spyOn(logger, "info").mockImplementation(() => {});
        rpc.getBlockNumber = async () => F.Fork - 1;
        await services.recovery.checkBlock(
            retainCanonicalCheckFixture(services.storage, F.Orphan),
        );
        expect(revision()).toBe(0);
        expect(owners(fixture.collectionId)).toEqual([
            { owner: F.OrphanOwner, amount: "1" },
        ]);
        expect(services.recoveries.getRecovery(1)?.phase).toBe(
            REORG_RECOVERY_PHASE.AwaitingAncestor,
        );
        expect(services.outbox.listDue(now, 10)).toHaveLength(0);
        expect(info).not.toHaveBeenCalledWith(
            expect.any(String),
            expect.objectContaining({
                action: REORG_RECOVERY_LOG_ACTION.RollbackCommitted,
            }),
        );
        rpc.getBlockNumber = async () => F.Fork;
        now += retryDelayMs;
        await services.recovery.resumeDue();
        expect(revision()).toBe(1);
        expect(owners(fixture.collectionId)).toEqual([
            { owner: F.Owner, amount: "1" },
        ]);
        expect(services.recoveries.getRecovery(1)).toBeNull();
        expect(services.outbox.listDue(now, 10)).toHaveLength(0);
        expect(info).toHaveBeenCalledWith(
            expect.any(String),
            expect.objectContaining({
                action: REORG_RECOVERY_LOG_ACTION.RollbackCommitted,
                capturedHeadBlock: F.Fork,
                resyncFromBlock: null,
                resyncToBlock: null,
                resyncBlocks: 0,
                firstBatchToBlock: null,
                revisionAfter: 1,
            }),
        );
    });

    it("rolls back checkpoints, ownership and revision if retaining resync state fails", async () => {
        const fixture = seedRecoveryHistory();
        const info = vi.spyOn(logger, "info").mockImplementation(() => {});
        db.exec(
            `CREATE TEMP TRIGGER fail_recovery_publication BEFORE UPDATE ON chain_reorg_recoveries WHEN NEW.phase = '${REORG_RECOVERY_PHASE.Resync}' BEGIN SELECT RAISE(ABORT, 'journal unavailable'); END;`,
        );
        await services.recovery.checkBlock(
            retainCanonicalCheckFixture(services.storage, F.Orphan),
        );
        expect(revision()).toBe(0);
        expect(owners(fixture.collectionId)).toEqual([
            { owner: F.OrphanOwner, amount: "1" },
        ]);
        expect(selectTransferCount(1, fixture.collectionId, "1")).toBe(1);
        expect(
            db
                .prepare(
                    "SELECT COUNT(*) AS count FROM erc721_ownership_checkpoints",
                )
                .get(),
        ).toEqual({ count: 0 });
        expect(services.recoveries.getRecovery(1)?.phase).toBe(
            REORG_RECOVERY_PHASE.AwaitingAncestor,
        );
        expect(info).not.toHaveBeenCalledWith(
            expect.any(String),
            expect.objectContaining({
                action: REORG_RECOVERY_LOG_ACTION.RollbackCommitted,
            }),
        );
        db.exec("DROP TRIGGER fail_recovery_publication;");
        now += retryDelayMs;
        await services.recovery.resumeDue();
        expect(revision()).toBe(1);
        expect(pendingRecoveryRange()).toBeDefined();
        expect(info).toHaveBeenCalledWith(
            expect.any(String),
            expect.objectContaining({
                action: REORG_RECOVERY_LOG_ACTION.RollbackCommitted,
                revisionAfter: 1,
            }),
        );
    });

    it("resumes direct acquisition after rollback and retries partial publication without acquiring again", async () => {
        const fixture = seedRecoveryHistory();
        await services.recovery.checkBlock(
            retainCanonicalCheckFixture(services.storage, F.Orphan),
        );
        const first = pendingRecoveryRange();
        reopen();
        queue.failureQueue = QUEUE_NAMES.OrdersDomain;
        expect(await services.acquireRecoveryRange(first)).toBe(true);
        expect(pendingRecoveryRange()).toMatchObject({
            fromBlock: 107,
            toBlock: 107,
        });
        const rpcReads = rpc.logReads;
        await services.publishRetained(queue);
        expect(
            services.storage.countCollectionSyncedBlocksInRange(
                1,
                fixture.collectionId,
                105,
                106,
            ),
        ).toBe(2);
        expect(
            db
                .prepare("SELECT status FROM queue_outbox WHERE queue_name = ?")
                .get(QUEUE_NAMES.OrdersDomain),
        ).toEqual({ status: QUEUE_OUTBOX_STATUS.FailedRetry });
        reopen();
        queue.failureQueue = undefined;
        await services.publishRetained(queue);
        expect(rpc.logReads).toBe(rpcReads);
        expect(await services.acquireRecoveryRange(first)).toBe(false);
        expect(await acquireAndPublish(pendingRecoveryRange())).toBe(true);
        expect(services.recoveries.getRecovery(1)).toBeNull();
        expect(revision()).toBe(1);
    });

    it("keeps required publication retryable beyond the ordinary budget after recovery completion", async () => {
        const ranges = vi.spyOn(rpc, "getLogs");
        seedRecoveryHistory();
        await services.recovery.checkBlock(
            retainCanonicalCheckFixture(services.storage, F.Orphan),
        );
        while (services.recoveries.getRecovery(1))
            expect(
                await services.acquireRecoveryRange(pendingRecoveryRange()),
            ).toBe(true);
        const completedCalls = ranges.mock.calls.length;
        queue.failureQueue = QUEUE_NAMES.OrdersDomain;
        for (let i = 0; i < 7; i++)
            await drainQueueOutbox(services.outbox, queue, {
                maxAttempts: 1,
                retryBaseDelayMs: 0,
            });
        expect(
            db
                .prepare(
                    "SELECT status, attempts FROM queue_outbox WHERE queue_name = ?",
                )
                .all(QUEUE_NAMES.OrdersDomain),
        ).toEqual([
            { status: QUEUE_OUTBOX_STATUS.FailedRetry, attempts: 7 },
            { status: QUEUE_OUTBOX_STATUS.FailedRetry, attempts: 7 },
        ]);
        reopen();
        queue.failureQueue = undefined;
        await services.publishRetained(queue);
        await services.executor.runDue();
        // Automatic discovery may repair unrelated older holes; publication
        // recovery must never repeat the completed resync range.
        expect(
            ranges.mock.calls
                .slice(completedCalls)
                .every(([filter]) => filter.toBlock <= F.Fork),
        ).toBe(true);
        expect(services.recoveries.getRecovery(1)).toBeNull();
    });

    it("retains unsupported recovery across an orphaned bootstrap anchor without changing ownership", async () => {
        const fixture = seedRecoveryHistory();
        db.prepare(
            "UPDATE collections SET bootstrap_anchor_block=? WHERE collection_id=?",
        ).run(F.Orphan, fixture.collectionId);
        const bootstrap = new SqliteBootstrapStorage();
        bootstrap.insertSnapshotRows([
            {
                runId: 1,
                chainId: 1,
                collectionId: fixture.collectionId,
                contract: fixture.contract,
                tokenId: "1",
                owner: F.OrphanOwner,
                anchorBlock: F.Orphan,
            },
        ]);
        bootstrap.finalizeSnapshot({
            runId: 1,
            chainId: 1,
            collectionId: fixture.collectionId,
            contract: fixture.contract,
            anchorBlock: F.Orphan,
            anchorHash: syncBlockFixture(F.Orphan).hash,
            anchorTimestamp: F.Orphan,
        });
        retainCanonicalCheckFixture(services.storage, F.Orphan);
        expect(await services.recovery.checkDue()).toBe(true);
        expect(services.recoveries.getRecovery(1)).toMatchObject({
            phase: REORG_RECOVERY_PHASE.AwaitingAncestor,
            retryAt: now + retryDelayMs,
        });
        db.raw.close();
        reopen();
        now += retryDelayMs;
        await services.recovery.resumeDue();
        expect(services.recoveries.getRecovery(1)?.phase).toBe(
            REORG_RECOVERY_PHASE.AwaitingAncestor,
        );
        expect(revision()).toBe(0);
        expect(owners(fixture.collectionId)).toEqual([
            { owner: F.OrphanOwner, amount: "1" },
        ]);
        expect(selectTransferCount(1, fixture.collectionId, "1")).toBe(1);
        expect(services.storage.getBlockHash(1, F.Orphan)).toBe(
            syncBlockFixture(F.Orphan).hash,
        );
        expect(
            db.prepare("SELECT last_error FROM chain_reorg_recoveries").get(),
        ).toEqual({ last_error: expect.stringContaining("bootstrap anchor") });
    });

    it("polls an earlier mismatch while retained ancestor proof is deferred", async () => {
        rpc = new RecoveryRpc(F.Fork - 1);
        services = reorgRecoveryServices(rpc, { now: () => now, retryDelayMs });
        const fixture = seedRecoveryHistory();
        retainCanonicalCheckFixture(services.storage, F.Orphan);
        expect(await services.recovery.checkDue()).toBe(true);
        const previous = services.recoveries.getRecovery(1)!;
        expect(previous).toMatchObject({
            phase: REORG_RECOVERY_PHASE.AwaitingAncestor,
            checkedBlock: F.Orphan,
            retryAt: now + retryDelayMs,
        });

        retainCanonicalCheckFixture(services.storage, F.Fork);
        expect(await services.recovery.checkDue()).toBe(true);
        const current = services.recoveries.getRecovery(1)!;
        expect(current).toMatchObject({
            phase: REORG_RECOVERY_PHASE.AwaitingAncestor,
            checkedBlock: F.Fork,
            version: previous.version + 1,
        });
        expect(current.recoveryId).not.toBe(previous.recoveryId);
        expect(revision()).toBe(0);
        expect(owners(fixture.collectionId)).toEqual([
            { owner: F.OrphanOwner, amount: "1" },
        ]);
    });

    it("fences stale proof superseded by an earlier mismatch", async () => {
        const fixture = seedRecoveryHistory();
        rpc.beforeOwnerRead = async () => {
            rpc.beforeOwnerRead = undefined;
            expect(
                services.checks.nextDue({
                    chainId: 1,
                    now,
                    upperBound: F.Orphan + 1,
                }),
            ).toBeNull(); // No imported header can own a check.
            retainCanonicalCheckFixture(services.storage, F.Fork);
            services.recoveries.retainMismatch({
                checkpoint: services.storage.captureSyncCheckpoint(1),
                recoveryId: "new-earlier-mismatch",
                checkedBlock: F.Fork,
                storedHash: services.storage.getBlockHash(1, F.Fork)!,
                observedHash: "different-fork",
                now,
            });
        };
        await services.recovery.checkBlock(
            retainCanonicalCheckFixture(services.storage, F.Orphan),
        );
        expect(revision()).toBe(0);
        expect(owners(fixture.collectionId)).toEqual([
            { owner: F.OrphanOwner, amount: "1" },
        ]);
        expect(services.recoveries.getRecovery(1)?.recoveryId).toBe(
            "new-earlier-mismatch",
        );
        // Retained proof has no ancestor in its bounded window; do not invent one.
        await services.recovery.resumeDue();
        expect(revision()).toBe(0);
    });

    it("rejects a new affected token discovered while the snapshot is in flight", async () => {
        const fixture = seedRecoveryHistory();
        rpc.beforeOwnerRead = async () => {
            rpc.beforeOwnerRead = undefined;
            fixture.persist([
                {
                    ...fixture.transfer(106, 1, F.Owner, F.OrphanOwner),
                    tokenId: "2",
                },
            ]);
        };
        await services.recovery.checkBlock(
            retainCanonicalCheckFixture(services.storage, F.Orphan),
        );
        expect(revision()).toBe(0);
        expect(selectTransferCount(1, fixture.collectionId, "2")).toBe(1);
        expect(
            db.prepare("SELECT last_error FROM chain_reorg_recoveries").get(),
        ).toEqual({ last_error: expect.stringContaining("scope changed") });
        now += retryDelayMs;
        await services.recovery.resumeDue();
        expect(revision()).toBe(1);
        expect(selectTransferCount(1, fixture.collectionId, "2")).toBe(0);
    });

    it("rejects pre-rollback realtime persistence through the actual range pipeline", async () => {
        seedRecoveryHistory();
        let released!: () => void;
        let entered!: () => void;
        const enteredPromise = new Promise<void>((resolve) => {
            entered = resolve;
        });
        const releasePromise = new Promise<void>((resolve) => {
            released = resolve;
        });
        rpc.beforeLogs = async () => {
            entered();
            await releasePromise;
        };
        const realtime = processSyncRange({
            reorgDepth: 3,
            rpc,
            storage: services.storage,
            commit: services.commit,
            canonicalChecks: services.checks,
            collectionScopeResolver: services.registry,
            collectionExtensions: { getInstall: () => null },
            chainId: 1,
            collections: services.registry.listCollectionsForSync(
                1,
                "realtime",
            ),
            range: { fromBlock: 107, toBlock: 107 },
            bidderIndex: { isActive: () => false, shouldEmit: () => false },
            wethAddress: F.Weth,
            orderMaintenancePolicy:
                BACKFILL_ORDER_MAINTENANCE_POLICY.CurrentState,
            sources: [
                {
                    fanoutId: "realtime",
                    sourceJobId: "realtime",
                    sourceKind: SYNC_JOB_KIND.RealtimeBlock,
                },
            ],
            mode: "realtime",
            completion: { kind: SYNC_WORK_COMPLETION.Unmanaged },
        });
        await enteredPromise;
        await services.recovery.checkBlock(
            retainCanonicalCheckFixture(services.storage, F.Orphan),
        );
        released();
        await expect(realtime).rejects.toBeInstanceOf(ChainSyncConflict);
        expect(services.storage.getBlockHash(1, 107)).toBeNull();
        expect(queue.jobs).toHaveLength(0);
    });

    it("preserves unfinished pre-fork range publications when a newer mismatch interrupts resync", async () => {
        seedRecoveryHistory();
        await services.recovery.checkBlock(
            retainCanonicalCheckFixture(services.storage, F.Orphan),
        );
        const old = pendingRecoveryRange();
        expect(await services.acquireRecoveryRange(old)).toBe(true);
        queue.failureQueue = QUEUE_NAMES.OrdersDomain;
        await services.publishRetained(queue);
        const previousId = services.recoveries.getRecovery(1)!.recoveryId,
            previousGetBlock = rpc.getBlock.bind(rpc);
        rpc.getBlock = async (number) => {
            const header = await previousGetBlock(number);
            return number < 106
                ? header
                : {
                      ...header,
                      hash: `0x${String(number + 20_000).padStart(64, "0")}`,
                  };
        };
        await services.recovery.checkBlock(
            retainCanonicalCheckFixture(services.storage, 106),
        );
        expect(revision()).toBe(2);
        expect(services.recoveries.getRecovery(1)!.recoveryId).not.toBe(
            previousId,
        );
        expect(pendingRecoveryRange()).toMatchObject({
            fromBlock: 106,
            toBlock: 107,
        });
        expect(
            db
                .prepare(
                    "SELECT job_json FROM queue_outbox WHERE queue_name = ? AND status = ?",
                )
                .all(QUEUE_NAMES.OrdersDomain, QUEUE_OUTBOX_STATUS.FailedRetry),
        ).toEqual([
            expect.objectContaining({
                job_json: expect.stringContaining('"fromBlock":105'),
            }),
        ]);
        expect(await services.acquireRecoveryRange(old)).toBe(false);
    });

    it("does not complete or acquire a retained reorg range when all eligible collections are paused", async () => {
        const fixture = seedRecoveryHistory();
        await services.recovery.checkBlock(
            retainCanonicalCheckFixture(services.storage, F.Orphan),
        );
        const range = pendingRecoveryRange();
        db.prepare(
            "UPDATE collections SET status = ? WHERE collection_id = ?",
        ).run(COLLECTION_STATUS.Paused, fixture.collectionId);
        await services.executor.runDue();
        expect(rpc.logReads).toBe(0);
        expect(pendingRecoveryRange()).toEqual(range);
        db.prepare(
            "UPDATE collections SET status = ? WHERE collection_id = ?",
        ).run(COLLECTION_STATUS.Bootstrapping, fixture.collectionId);
        expect(await services.acquireRecoveryRange(range)).toBe(true);
    });
});
