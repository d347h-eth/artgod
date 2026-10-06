import { beforeEach, describe, expect, it, vi } from "vitest";
import { db, setDbPath } from "@artgod/shared/database";
import { createMigrationRunner } from "@artgod/shared/migrations";
import { COLLECTION_STATUS } from "@artgod/shared/types";
import { startReorgRecoveryLoop } from "../src/application/reorg-recovery.js";
import {
    SyncGapScheduler,
    executeSyncGapRepair,
} from "../src/application/sync-gap-scheduler.js";
import { drainQueueOutbox } from "../src/application/queue-outbox/drainer.js";
import { runWorker } from "../src/application/worker-runner.js";
import { ChainSyncConflict } from "../src/domain/chain-sync.js";
import { REORG_RECOVERY_PHASE } from "../src/domain/reorg-recovery.js";
import { QUEUE_OUTBOX_STATUS } from "../src/domain/queue-outbox.js";
import {
    SYNC_JOB_KIND,
    BACKFILL_SOURCE,
    BACKFILL_ORDER_MAINTENANCE_POLICY,
    type BackfillSyncPayload,
} from "../src/domain/sync-jobs.js";
import { REORG_JOB_KIND } from "../src/domain/reorg-jobs.js";
import { QUEUE_NAMES, type QueueName } from "../src/domain/queues.js";
import type { JobEnvelope } from "../src/domain/jobs.js";
import type { QueueMessage, QueuePort } from "../src/ports/queue.js";
import { SqliteSyncGapStore } from "../src/infra/storage/sqlite-sync-gaps.js";
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
    pendingRecoveryJob,
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
    function reopen() {
        setDbPath(dbPath);
        services = reorgRecoveryServices(rpc, { now: () => now, retryDelayMs });
    }
    function revision() {
        return services.storage.captureSyncCheckpoint(F.ChainId).revision;
    }
    function owners(collectionId: number) {
        return selectBalanceOwners(F.ChainId, collectionId, "1");
    }

    it("retains the original delivery beyond its DLQ budget until mismatch persistence succeeds", async () => {
        seedRecoveryHistory();
        db.exec(
            "CREATE TEMP TRIGGER fail_mismatch_retention BEFORE INSERT ON chain_reorg_recoveries BEGIN SELECT RAISE(ABORT, 'journal unavailable'); END;",
        );
        const ack = vi.fn(async () => {});
        const nack = vi.fn(async () => {});
        const stop = await runWorker(
            queue,
            {
                queue: QUEUE_NAMES.BlockCheck,
                consumerName: "retention-test",
                maxAttempts: 1,
                deadLetterQueue: QUEUE_NAMES.DeadLetter,
            },
            async (job: JobEnvelope<{ blockNumber: number }>) =>
                services.recovery.checkBlock(job.payload.blockNumber),
        );
        const message = {
            data: {
                jobId: "unretained-check",
                kind: REORG_JOB_KIND.BlockCheck,
                queue: QUEUE_NAMES.BlockCheck,
                chainId: 1,
                scheduledAt: 0,
                attempt: 10,
                payload: { blockNumber: F.Orphan },
            },
            ack,
            nack,
            touch: async () => {},
        };
        await queue.handler!(message);
        expect(ack).not.toHaveBeenCalled();
        expect(nack).toHaveBeenCalledWith({ delayMs: retryDelayMs });
        expect(queue.jobs).toHaveLength(0); // No DLQ acknowledgement can relinquish the only owner.
        expect(services.recoveries.getRecovery(1)).toBeNull();
        expect(revision()).toBe(0);
        db.exec("DROP TRIGGER fail_mismatch_retention;");
        await queue.handler!(message);
        expect(ack).toHaveBeenCalledOnce();
        expect(revision()).toBe(1);
        expect(services.recoveries.getRecovery(1)?.phase).toBe(
            REORG_RECOVERY_PHASE.Resync,
        );
        await stop();
    });

    it.each(["rpc", "wrong-height", "checkpoint-read", "header-read"] as const)(
        "retains the only check owner after journal deferrals followed by a pre-handoff %s failure",
        async (failure) => {
            const fixture = seedRecoveryHistory();
            db.exec(
                "CREATE TEMP TRIGGER fail_mismatch_retention BEFORE INSERT ON chain_reorg_recoveries BEGIN SELECT RAISE(ABORT, 'journal unavailable'); END;",
            );
            const ack = vi.fn(async () => {});
            const nack = vi.fn(async () => {});
            const stop = await runWorker(
                queue,
                {
                    queue: QUEUE_NAMES.BlockCheck,
                    consumerName: "pre-handoff-test",
                    maxAttempts: 5,
                    deadLetterQueue: QUEUE_NAMES.DeadLetter,
                },
                async (job: JobEnvelope<{ blockNumber: number }>) =>
                    services.recovery.checkBlock(job.payload.blockNumber),
            );
            const message: QueueMessage<{ blockNumber: number }> = {
                data: {
                    jobId: "unretained-check",
                    kind: REORG_JOB_KIND.BlockCheck,
                    queue: QUEUE_NAMES.BlockCheck,
                    chainId: F.ChainId,
                    scheduledAt: 0,
                    attempt: 1,
                    payload: { blockNumber: F.Orphan },
                },
                ack,
                nack,
                touch: async () => {},
            };
            for (let attempt = 1; attempt <= 5; attempt++) {
                message.data.attempt = attempt;
                await queue.handler!(message);
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
            message.data.attempt = 6;
            await queue.handler!(message);
            expect(ack).not.toHaveBeenCalled();
            expect(nack).toHaveBeenCalledTimes(6);
            expect(nack).toHaveBeenLastCalledWith({ delayMs: retryDelayMs });
            expect(queue.jobs).toHaveLength(0);
            expect(services.recoveries.getRecovery(F.ChainId)).toBeNull();
            await services.recovery.resumeDue();
            expect(revision()).toBe(0);
            expect(owners(fixture.collectionId)).toEqual([
                { owner: F.OrphanOwner, amount: "1" },
            ]);

            message.data.attempt = 7;
            await queue.handler!(message);
            expect(ack).toHaveBeenCalledOnce();
            expect(services.recoveries.getRecovery(F.ChainId)?.phase).toBe(
                REORG_RECOVERY_PHASE.Resync,
            );
            let ranges = 0;
            while (services.recoveries.getRecovery(F.ChainId)) {
                expect(
                    await services.execute(pendingRecoveryJob(), queue),
                ).toBe(true);
                expect(++ranges).toBeLessThanOrEqual(2);
            }
            expect(ranges).toBe(2);
            expect(revision()).toBe(1);
            expect(owners(fixture.collectionId)).toEqual([
                { owner: F.Owner, amount: "1" },
            ]);
            expect(
                selectTransferCount(F.ChainId, fixture.collectionId, "1"),
            ).toBe(0);
            expect(
                services.storage.countCollectionSyncedBlocksInRange(
                    F.ChainId,
                    fixture.collectionId,
                    F.Orphan,
                    F.Head,
                ),
            ).toBe(3);
            expect(
                queue.jobs.some((job) => job.queue === QUEUE_NAMES.DeadLetter),
            ).toBe(false);
            await stop();
        },
    );

    it("leaves retry with retained recovery when a post-handoff continuation reaches DLQ", async () => {
        const fixture = seedRecoveryHistory();
        vi.spyOn(rpc, "readContractAtBlock").mockRejectedValueOnce(
            new Error("Ownership RPC unavailable"),
        );
        vi.spyOn(services.recoveries, "deferProof").mockImplementationOnce(
            () => {
                throw new Error("Retry bookkeeping unavailable");
            },
        );
        const ack = vi.fn(async () => {});
        const stop = await runWorker(
            queue,
            {
                queue: QUEUE_NAMES.BlockCheck,
                consumerName: "post-handoff-test",
                maxAttempts: 5,
                deadLetterQueue: QUEUE_NAMES.DeadLetter,
            },
            async (job: JobEnvelope<{ blockNumber: number }>) =>
                services.recovery.checkBlock(job.payload.blockNumber),
        );
        await queue.handler!({
            data: {
                jobId: "retained-check",
                kind: REORG_JOB_KIND.BlockCheck,
                queue: QUEUE_NAMES.BlockCheck,
                chainId: F.ChainId,
                scheduledAt: 0,
                attempt: 6,
                payload: { blockNumber: F.Orphan },
            },
            ack,
            nack: vi.fn(async () => {}),
            touch: async () => {},
        });
        expect(ack).toHaveBeenCalledOnce();
        expect(
            queue.jobs.filter((job) => job.queue === QUEUE_NAMES.DeadLetter),
        ).toHaveLength(1);
        expect(services.recoveries.getRecovery(F.ChainId)?.phase).toBe(
            REORG_RECOVERY_PHASE.AwaitingAncestor,
        );
        expect(revision()).toBe(0);
        await services.recovery.resumeDue();
        expect(revision()).toBe(1);
        expect(owners(fixture.collectionId)).toEqual([
            { owner: F.Owner, amount: "1" },
        ]);
        await stop();
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
        const scheduler = new SyncGapScheduler(services.registry, gaps, queue, {
            chainId: F.ChainId,
            batchSize: F.BatchSize,
            now: () => now,
        });
        async function repairNext(expected: number[]) {
            await scheduler.scan(F.Orphan);
            const job = queue.jobs
                .filter((j) => j.queue === QUEUE_NAMES.BackfillSync)
                .at(-1)! as JobEnvelope<BackfillSyncPayload>;
            expect([job.payload.fromBlock, job.payload.toBlock]).toEqual(
                expected,
            );
            expect(
                await executeSyncGapRepair(
                    job,
                    services.registry,
                    gaps,
                    (collections, sources) =>
                        services.syncAndPublish(job, queue, {
                            collections,
                            sources,
                        }),
                ),
            ).toBe(true);
        }
        await services.recovery.checkBlock(F.Orphan);
        expect(services.recoveries.getRecovery(F.ChainId)?.phase).toBe(
            REORG_RECOVERY_PHASE.AwaitingAncestor,
        );

        // Descending collection repair first inserts canonical 104 between orphan
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
            const job = pendingRecoveryJob();
            ranges.push([job.payload.fromBlock, job.payload.toBlock]);
            expect(await services.execute(job, queue)).toBe(true);
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
            await services.recovery.checkBlock(F.Orphan);
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

    it("acknowledges retained mismatch, fills missing ancestors through actual gap processing, then recovers at stationary HEAD after reopen", async () => {
        const fixture = seedRecoveryHistory(false);
        const ack = vi.fn(async () => {});
        const nack = vi.fn(async () => {});
        const stop = await runWorker(
            queue,
            { queue: QUEUE_NAMES.BlockCheck, consumerName: "recovery-test" },
            async (job: JobEnvelope<{ blockNumber: number }>) =>
                services.recovery.checkBlock(job.payload.blockNumber),
        );
        await queue.handler!({
            data: {
                jobId: "check-105",
                kind: REORG_JOB_KIND.BlockCheck,
                queue: QUEUE_NAMES.BlockCheck,
                chainId: 1,
                scheduledAt: 0,
                attempt: 1,
                payload: { blockNumber: F.Orphan },
            },
            ack,
            nack,
            touch: async () => {},
        });
        await stop();
        expect(ack).toHaveBeenCalledOnce();
        expect(nack).not.toHaveBeenCalled();
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
        const scheduler = new SyncGapScheduler(services.registry, gaps, queue, {
            chainId: 1,
            batchSize: F.BatchSize,
            now: () => now,
        });
        const repaired: number[][] = [];
        for (let i = 0; i < 3; i++) {
            await scheduler.scan(F.Head);
            const job = queue.jobs
                .filter((j) => j.queue === QUEUE_NAMES.BackfillSync)
                .at(-1)! as JobEnvelope<BackfillSyncPayload>;
            repaired.push([job.payload.fromBlock, job.payload.toBlock]);
            expect(
                await executeSyncGapRepair(
                    job,
                    services.registry,
                    gaps,
                    (collections, sources) =>
                        services.syncAndPublish(job, queue, {
                            collections,
                            sources,
                        }),
                ),
            ).toBe(true);
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
        expect(pendingRecoveryJob().payload).toMatchObject({
            fromBlock: 105,
            toBlock: 106,
        });
        while (services.recoveries.getRecovery(1)) {
            const job = pendingRecoveryJob();
            await drainQueueOutbox(services.outbox, queue);
            expect(await services.execute(job, queue)).toBe(true);
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
            await services.execute(
                queue.jobs.find(
                    (j) =>
                        j.queue === QUEUE_NAMES.BackfillSync &&
                        j.payload &&
                        "recovery" in (j.payload as object),
                )! as JobEnvelope<BackfillSyncPayload>,
                queue,
            ),
        ).toBe(false);
    });

    it("unknown ownership failure retains proof without rollback; matching checks have no recovery", async () => {
        const fixture = seedRecoveryHistory();
        await services.recovery.checkBlock(F.Fork);
        expect(services.recoveries.getRecovery(1)).toBeNull();
        rpc.beforeOwnerRead = async () => {
            throw new Error("Historical state unavailable");
        };
        await services.recovery.checkBlock(F.Orphan);
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
        rpc.getBlockNumber = async () => F.Fork - 1;
        await services.recovery.checkBlock(F.Orphan);
        expect(revision()).toBe(0);
        expect(owners(fixture.collectionId)).toEqual([
            { owner: F.OrphanOwner, amount: "1" },
        ]);
        expect(services.recoveries.getRecovery(1)?.phase).toBe(
            REORG_RECOVERY_PHASE.AwaitingAncestor,
        );
        expect(services.outbox.listDue(now, 10)).toHaveLength(0);
        rpc.getBlockNumber = async () => F.Fork;
        now += retryDelayMs;
        await services.recovery.resumeDue();
        expect(revision()).toBe(1);
        expect(owners(fixture.collectionId)).toEqual([
            { owner: F.Owner, amount: "1" },
        ]);
        expect(services.recoveries.getRecovery(1)).toBeNull();
        expect(services.outbox.listDue(now, 10)).toHaveLength(0);
    });

    it("rolls back the entire transaction if the continuation cannot be retained", async () => {
        const fixture = seedRecoveryHistory();
        db.exec(
            "CREATE TEMP TRIGGER fail_recovery_publication BEFORE INSERT ON queue_outbox BEGIN SELECT RAISE(ABORT, 'outbox unavailable'); END;",
        );
        await services.recovery.checkBlock(F.Orphan);
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
        db.exec("DROP TRIGGER fail_recovery_publication;");
        now += retryDelayMs;
        await services.recovery.resumeDue();
        expect(revision()).toBe(1);
        expect(pendingRecoveryJob()).toBeDefined();
    });

    it("resumes after rollback commit before publication and after coverage with partial fanout", async () => {
        const fixture = seedRecoveryHistory();
        await services.recovery.checkBlock(F.Orphan);
        const first = pendingRecoveryJob();
        reopen();
        queue.failureQueue = QUEUE_NAMES.OrdersDomain;
        await expect(services.execute(first, queue)).rejects.toThrow(
            "Publication unavailable",
        );
        expect(
            services.storage.countCollectionSyncedBlocksInRange(
                1,
                fixture.collectionId,
                105,
                106,
            ),
        ).toBe(2);
        expect(
            queue.jobs.filter((j) => j.queue === QUEUE_NAMES.ActivityDomain),
        ).toHaveLength(1);
        expect(services.recoveries.getRecovery(1)).toMatchObject({
            phase: REORG_RECOVERY_PHASE.Resync,
            fromBlock: 105,
            toBlock: 106,
        });
        reopen();
        now += retryDelayMs;
        await services.recovery.resumeDue();
        const redrive = pendingRecoveryJob();
        expect(redrive.jobId).not.toBe(first.jobId);
        expect(redrive.payload).toEqual(first.payload);
        queue.failureQueue = undefined;
        // An old delivery can finish this same logical range after redrive.
        expect(await services.execute(first, queue)).toBe(true);
        expect(await services.execute(redrive, queue)).toBe(false);
        expect(pendingRecoveryJob().payload).toMatchObject({
            fromBlock: 107,
            toBlock: 107,
        });
        expect(await services.execute(pendingRecoveryJob(), queue)).toBe(true);
        expect(services.recoveries.getRecovery(1)).toBeNull();
        expect(revision()).toBe(1); // Restart never performs rollback a second time.
    });

    it("redrives terminal and acknowledged publication states without erasing logical work", async () => {
        seedRecoveryHistory();
        await services.recovery.checkBlock(F.Orphan);
        const first = pendingRecoveryJob();
        queue.failureQueue = QUEUE_NAMES.BackfillSync;
        await drainQueueOutbox(services.outbox, queue, { maxAttempts: 1 });
        expect(db.prepare("SELECT status FROM queue_outbox").get()).toEqual({
            status: QUEUE_OUTBOX_STATUS.FailedTerminal,
        });
        now += retryDelayMs;
        await services.recovery.resumeDue();
        queue.failureQueue = undefined;
        const second = pendingRecoveryJob();
        await drainQueueOutbox(services.outbox, queue);
        expect(db.prepare("SELECT status FROM queue_outbox").get()).toEqual({
            status: QUEUE_OUTBOX_STATUS.Sent,
        });
        now += retryDelayMs;
        await services.recovery.resumeDue(); // Also redrive a delivery ACKed without completion.
        const third = pendingRecoveryJob();
        expect(new Set([first.jobId, second.jobId, third.jobId]).size).toBe(3);
        expect(third.payload).toEqual(first.payload);
        expect(
            db.prepare("SELECT COUNT(*) AS count FROM queue_outbox").get(),
        ).toEqual({ count: 1 });
        expect(await services.execute(third, queue)).toBe(true);
    });

    it("fences stale proof superseded by an earlier mismatch", async () => {
        const fixture = seedRecoveryHistory();
        rpc.beforeOwnerRead = async () => {
            rpc.beforeOwnerRead = undefined;
            await services.recovery.checkBlock(F.Orphan + 1); // No stored header: no false mismatch.
            services.recoveries.retainMismatch({
                checkpoint: services.storage.captureSyncCheckpoint(1),
                recoveryId: "new-earlier-mismatch",
                checkedBlock: F.Fork,
                storedHash: services.storage.getBlockHash(1, F.Fork)!,
                observedHash: "different-fork",
                now,
            });
        };
        await services.recovery.checkBlock(F.Orphan);
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
        await services.recovery.checkBlock(F.Orphan);
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
        const realtime = services.syncAndPublish(
            {
                jobId: "realtime",
                chainId: 1,
                queue: QUEUE_NAMES.RealtimeSync,
                kind: SYNC_JOB_KIND.RealtimeBlock,
                scheduledAt: 0,
                payload: {
                    fromBlock: 107,
                    toBlock: 107,
                    source: BACKFILL_SOURCE.ManualHistorical,
                    orderMaintenancePolicy:
                        BACKFILL_ORDER_MAINTENANCE_POLICY.CurrentState,
                },
            },
            queue,
        );
        await enteredPromise;
        await services.recovery.checkBlock(F.Orphan);
        released();
        await expect(realtime).rejects.toBeInstanceOf(ChainSyncConflict);
        expect(services.storage.getBlockHash(1, 107)).toBeNull();
        expect(queue.jobs).toHaveLength(0);
    });

    it("preserves unfinished fanout when a newer mismatch interrupts resync", async () => {
        seedRecoveryHistory();
        await services.recovery.checkBlock(F.Orphan);
        const oldJob = pendingRecoveryJob();
        queue.failureQueue = QUEUE_NAMES.OrdersDomain;
        await expect(services.execute(oldJob, queue)).rejects.toThrow();
        const previousId = services.recoveries.getRecovery(1)!.recoveryId;
        const previousGetBlock = rpc.getBlock.bind(rpc);
        rpc.getBlock = async (number) => {
            const block = await previousGetBlock(number);
            return number < 106
                ? block
                : {
                      ...block,
                      hash: `0x${String(number + 20_000).padStart(64, "0")}`,
                  };
        };
        await services.recovery.checkBlock(106);
        expect(revision()).toBe(2);
        expect(services.recoveries.getRecovery(1)!.recoveryId).not.toBe(
            previousId,
        );
        // The rollback begins at 106, but fanout from 105 never completed.
        expect(pendingRecoveryJob().payload).toMatchObject({
            fromBlock: 105,
            toBlock: 106,
        });
        expect(await services.execute(oldJob, queue)).toBe(false);
    });

    it("rejects incorrectly scoped or configured jobs as chain recovery completion", async () => {
        const fixture = seedRecoveryHistory();
        await services.recovery.checkBlock(F.Orphan);
        const job = pendingRecoveryJob();
        expect(
            await services.execute(
                { ...job, collectionId: fixture.collectionId },
                queue,
            ),
        ).toBe(false);
        expect(
            await services.execute(
                {
                    ...job,
                    payload: {
                        ...job.payload,
                        orderMaintenancePolicy:
                            BACKFILL_ORDER_MAINTENANCE_POLICY.SkipGlobalMakerRevalidation,
                    },
                },
                queue,
            ),
        ).toBe(false);
        expect(rpc.logReads).toBe(0);
        db.prepare(
            "UPDATE collections SET status = ? WHERE collection_id = ?",
        ).run(COLLECTION_STATUS.Paused, fixture.collectionId);
        expect(services.registry.listCollectionsForSync(1, "backfill")).toEqual(
            [],
        );
        expect(services.recoveries.getRecovery(1)?.phase).toBe(
            REORG_RECOVERY_PHASE.Resync,
        );
    });
});
