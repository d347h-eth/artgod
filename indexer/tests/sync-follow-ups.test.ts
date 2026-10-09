import { FINALIZED_SYNC_CHECK_POLICY } from "./helpers/chain-fixture.js";
import { SqliteCanonicalChecks } from "../src/infra/storage/sqlite-canonical-checks.js";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { db, setDbPath } from "@artgod/shared/database";
import { createMigrationRunner } from "@artgod/shared/migrations";
import {
    buildSyncFollowUps,
    processSyncRange,
} from "../src/application/sync-range-processing.js";
import { drainQueueOutbox } from "../src/application/queue-outbox/drainer.js";
import { CanonicalSyncJobAdmission } from "../src/application/canonical-sync-job-admission.js";
import { ChainSyncConflict } from "../src/domain/chain-sync.js";
import { DOMAIN_JOB_KIND } from "../src/domain/domain-jobs.js";
import type { JobEnvelope } from "../src/domain/jobs.js";
import { GLOBAL_MAKER_TRIGGER_REASON } from "../src/domain/maker-triggers.js";
import { SYNC_FOLLOW_UP_KIND } from "../src/domain/sync-follow-ups.js";
import {
    QUEUE_OUTBOX_RETRY_POLICY,
    QUEUE_OUTBOX_STATUS,
} from "../src/domain/queue-outbox.js";
import { BACKFILL_ORDER_MAINTENANCE_POLICY } from "../src/domain/sync-jobs.js";
import type { SyncRangeResult } from "../src/ports/storage.js";
import type { QueuePort } from "../src/ports/queue.js";
import { SqliteQueueOutbox } from "../src/infra/queue/sqlite-queue-outbox.js";
import { SqliteSyncGapStore } from "../src/infra/storage/sqlite-sync-gaps.js";
import { SqliteReorgRecoveries } from "../src/infra/storage/sqlite-reorg-recoveries.js";
import { SYNC_WORK_COMPLETION } from "../src/domain/sync-work.js";
import { SqliteSyncRangeCommit } from "../src/infra/storage/sqlite-sync-range-commit.js";
import { SqliteCollectionRegistry } from "../src/infra/collections/sqlite.js";
import { syncBlockFixture as block } from "./helpers/chain-fixture.js";
import { createTempDbPath } from "./helpers/test-helpers.js";
import { loadTestEnv } from "./helpers/test-env.js";
import {
    emptyOnChainData,
    loadCollection,
    selectBalanceOwners,
    transferFixture,
} from "./helpers/ownership-fixture.js";
import { commitRollbackFixture } from "./helpers/rollback-fixture.js";
import {
    RecoveryRpc,
    REORG_FIXTURE,
} from "./helpers/reorg-recovery-fixture.js";
import { runWorker } from "../src/application/worker-runner.js";
import type { QueueMessage } from "../src/ports/queue.js";

const OWNER = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const NEXT = "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
const SOURCE = {
    fanoutId: "sync-fixture",
    sourceJobId: "sync-fixture",
    sourceKind: "sync-fixture",
};
const POLICY = BACKFILL_ORDER_MAINTENANCE_POLICY.CurrentState;

describe("atomic sync follow-up retention", () => {
    loadTestEnv();
    let dbPath: string;
    beforeEach(async () => {
        dbPath = await createTempDbPath();
        setDbPath(dbPath);
        await createMigrationRunner().runMigrations();
    });

    function fixture() {
        const f = transferFixture();
        const data = emptyOnChainData();
        data.collectionScoped.nftTransferEvents.push(
            f.transfer(103, 1, OWNER, NEXT),
        );
        // This maker hint has no raw persistence table; it must survive a crash.
        data.global.makerTriggers.push({
            maker: OWNER,
            reason: GLOBAL_MAKER_TRIGGER_REASON.Erc20Balance,
            blockNumber: 103,
            blockHash: block(103).hash,
            txHash: f.transfer(103, 2, OWNER, NEXT).txHash,
            logIndex: 2,
        });
        const result: SyncRangeResult = {
            canonicalCheck: FINALIZED_SYNC_CHECK_POLICY,
            checkpoint: f.storage.captureSyncCheckpoint(1),
            blocks: [101, 102, 103].map(block),
            data,
            collections: [loadCollection(1, f.collectionId)],
        };
        const followUps = buildSyncFollowUps(
            1,
            result.collections,
            { fromBlock: 101, toBlock: 103 },
            [SOURCE],
            "backfill",
            data,
            POLICY,
        );
        const outbox = new SqliteQueueOutbox();
        return {
            ...f,
            result,
            followUps,
            completion: { kind: SYNC_WORK_COMPLETION.Unmanaged },
            outbox,
            commit: new SqliteSyncRangeCommit({
                storage: f.storage,
                outbox,
                gaps: new SqliteSyncGapStore(),
                recoveries: new SqliteReorgRecoveries(
                    f.storage,
                    new SqliteCanonicalChecks(),
                ),
                collections: new SqliteCollectionRegistry(),
            }),
        };
    }

    it("rolls back all facts, coverage and balances if retaining a later follow-up fails", () => {
        const f = fixture();
        db.exec(
            `CREATE TEMP TRIGGER fail_sync_followup BEFORE INSERT ON queue_outbox WHEN NEW.job_kind = '${DOMAIN_JOB_KIND.MetadataSync}' BEGIN SELECT RAISE(ABORT, 'fixture outbox failure'); END;`,
        );
        expect(() => f.commit.commitSyncRange(f)).toThrow(
            "fixture outbox failure",
        );
        expect(
            f.storage.countCollectionSyncedBlocksInRange(
                1,
                f.collectionId,
                101,
                103,
            ),
        ).toBe(0);
        expect(selectBalanceOwners(1, f.collectionId, "1")).toEqual([]);
        expect(count("nft_transfer_events")).toBe(0);
        expect(count("queue_outbox")).toBe(0);
        expect(count("blocks")).toBe(0);
        db.exec("DROP TRIGGER fail_sync_followup;");
        f.commit.commitSyncRange(f);
        expect(count("queue_outbox")).toBe(4);
        expect(selectBalanceOwners(1, f.collectionId, "1")).toEqual([
            { owner: NEXT, amount: "1" },
        ]);
    });

    it("retains ephemeral hints across reopen and retries publication beyond the ordinary budget", async () => {
        const f = fixture();
        f.commit.commitSyncRange(f);
        f.commit.commitSyncRange(f); // same acquisition identities are idempotent
        expect(count("queue_outbox")).toBe(4);
        setDbPath(dbPath);
        const outbox = new SqliteQueueOutbox();
        const publish = vi.fn<QueuePort["publish"]>(async () => {
            throw new Error("broker unavailable");
        });
        for (let attempt = 0; attempt < 7; attempt++)
            expect(
                await drainQueueOutbox(
                    outbox,
                    { publish },
                    {
                        maxAttempts: 1,
                        retryBaseDelayMs: 0,
                    },
                ),
            ).toBe(0);
        const rows = db
            .prepare("SELECT status, retry_policy, attempts FROM queue_outbox")
            .all();
        expect(rows).toEqual(
            Array.from({ length: 4 }, () => ({
                status: QUEUE_OUTBOX_STATUS.FailedRetry,
                retry_policy: QUEUE_OUTBOX_RETRY_POLICY.Required,
                attempts: 7,
            })),
        );
        publish.mockResolvedValue(undefined);
        expect(await drainQueueOutbox(outbox, { publish })).toBe(4);
        expect(count("queue_outbox")).toBe(0);
        const jobs = publish.mock.calls.slice(-4).map(([, job]) => job);
        expect(
            jobs.every((job) => job.jobId.endsWith("chain-revision:0")),
        ).toBe(true);
        expect(jobs.find((job) => job.onchainBlock)?.onchainBlock).toEqual({
            chainId: 1,
            blockNumber: 103,
            blockHash: block(103).hash,
        });
    });

    it("does no additional RPC acquisition when publication fails or loses its reply", async () => {
        const f = transferFixture();
        const rpc = new RecoveryRpc(200);
        const headers = vi.spyOn(rpc, "getBlock");
        const outbox = new SqliteQueueOutbox();
        await processSyncRange({
            reorgDepth: 3,
            rpc,
            storage: f.storage,
            commit: new SqliteSyncRangeCommit({
                storage: f.storage,
                outbox,
                gaps: new SqliteSyncGapStore(),
                recoveries: new SqliteReorgRecoveries(
                    f.storage,
                    new SqliteCanonicalChecks(),
                ),
                collections: new SqliteCollectionRegistry(),
            }),
            collectionScopeResolver: new SqliteCollectionRegistry(),
            collectionExtensions: { getInstall: () => null },
            chainId: 1,
            collections: [loadCollection(1, f.collectionId)],
            range: { fromBlock: 101, toBlock: 103 },
            bidderIndex: { isActive: () => false, shouldEmit: () => false },
            wethAddress: REORG_FIXTURE.Weth,
            orderMaintenancePolicy: POLICY,
            sources: [SOURCE],
            mode: "backfill",
            completion: { kind: SYNC_WORK_COMPLETION.Unmanaged },
        });
        const calls = {
            logs: rpc.logReads,
            headers: headers.mock.calls.length,
        };
        const accepted: JobEnvelope[] = [];
        const publish = vi.fn<QueuePort["publish"]>(async (_queue, job) => {
            accepted.push(job);
            throw new Error("accepted but reply lost");
        });
        await drainQueueOutbox(
            outbox,
            { publish },
            {
                retryBaseDelayMs: 0,
            },
        );
        publish.mockImplementation(async (_queue, job) => {
            accepted.push(job);
        });
        expect(await drainQueueOutbox(outbox, { publish })).toBe(3);
        expect(accepted.slice(0, 3).map((job) => job.jobId)).toEqual(
            accepted.slice(3).map((job) => job.jobId),
        );
        expect({
            logs: rpc.logReads,
            headers: headers.mock.calls.length,
        }).toEqual(calls);
    });

    it("retries accepted publication when local completion fails, without remote acquisition", async () => {
        const f = fixture();
        f.commit.commitSyncRange(f);
        const accepted: JobEnvelope[] = [];
        const publish = async (_queue: unknown, job: JobEnvelope) => {
            accepted.push(job);
        };
        vi.spyOn(
            f.outbox,
            "removePublishedSyncFollowUp",
        ).mockImplementationOnce(() => {
            throw new Error("completion temporarily unavailable");
        });
        expect(
            await drainQueueOutbox(
                f.outbox,
                { publish },
                {
                    maxAttempts: 1,
                    retryBaseDelayMs: 0,
                },
            ),
        ).toBe(3);
        expect(count("queue_outbox")).toBe(1);
        expect(
            await drainQueueOutbox(
                f.outbox,
                { publish },
                {
                    maxAttempts: 1,
                    retryBaseDelayMs: 0,
                },
            ),
        ).toBe(1);
        expect(accepted.at(-1)!.jobId).toBe(accepted[0].jobId);
        expect(count("queue_outbox")).toBe(0);
    });

    it("removes orphan event publications but preserves unfinished range publications and canonical pre-fork hints", () => {
        const f = fixture();
        f.result.blocks = [100, 101, 102, 103].map(block);
        f.result.data.global.makerTriggers.push({
            ...f.result.data.global.makerTriggers[0],
            blockNumber: 101,
            blockHash: block(101).hash,
            logIndex: 3,
        });
        f.followUps = buildSyncFollowUps(
            1,
            f.result.collections,
            { fromBlock: 100, toBlock: 103 },
            [SOURCE],
            "backfill",
            f.result.data,
            POLICY,
        );
        f.commit.commitSyncRange(f);
        const jobs = f.outbox
            .listDue(Date.now(), 10)
            .map((row) => JSON.parse(row.jobJson) as JobEnvelope);
        const orphan = jobs.find(
            (job) => job.onchainBlock?.blockNumber === 103,
        )!;
        const beforeFork = jobs.find(
            (job) => job.onchainBlock?.blockNumber === 101,
        )!;
        const admission = new CanonicalSyncJobAdmission(f.storage);
        expect(admission.isCurrent(orphan)).toBe(true);
        commitRollbackFixture({
            storage: f.storage,
            chainId: 1,
            fromBlock: 102,
            owners: [
                { collectionId: f.collectionId, tokenId: "1", owner: OWNER },
            ],
        });
        expect(count("queue_outbox")).toBe(4); // three DB range jobs plus one valid event
        expect(admission.isCurrent(orphan)).toBe(false); // also fences an already published message
        expect(admission.isCurrent(beforeFork)).toBe(true);
        expect(
            admission.isCurrent(jobs.find((job) => !job.onchainBlock)!),
        ).toBe(true);
    });

    it("atomically rejects stale revisions and a follow-up from another fork", () => {
        const f = fixture();
        f.result.checkpoint.revision = 1;
        expect(() => f.commit.commitSyncRange(f)).toThrow(ChainSyncConflict);
        expect(count("queue_outbox")).toBe(0);
        f.result.checkpoint.revision = 0;
        const event = f.followUps.find(
            (followUp) => followUp.kind === SYNC_FOLLOW_UP_KIND.Event,
        )!;
        if (event.kind !== SYNC_FOLLOW_UP_KIND.Event)
            throw new Error("missing fixture event");
        event.block.blockHash = block(999).hash;
        expect(() => f.commit.commitSyncRange(f)).toThrow(ChainSyncConflict);
        expect(count("blocks")).toBe(0);
        expect(count("queue_outbox")).toBe(0);
    });

    it("keeps ordinary outbox publication limits unchanged", async () => {
        const f = fixture();
        f.outbox.enqueueJob(f.followUps[0].job);
        const queue = {
            publish: async () => {
                throw new Error("unavailable");
            },
        } as unknown as QueuePort;
        expect(
            await drainQueueOutbox(f.outbox, queue, { maxAttempts: 1 }),
        ).toBe(0);
        expect(
            db.prepare("SELECT status, retry_policy FROM queue_outbox").get(),
        ).toEqual({
            status: QUEUE_OUTBOX_STATUS.FailedTerminal,
            retry_policy: QUEUE_OUTBOX_RETRY_POLICY.Bounded,
        });
    });

    it("ACKs an already queued orphan hint without admitting its handler", async () => {
        const f = fixture();
        f.commit.commitSyncRange(f);
        const job = f.outbox
            .listDue(Date.now(), 10)
            .map((row) => JSON.parse(row.jobJson) as JobEnvelope)
            .find((job) => job.onchainBlock)!;
        let consume!: (message: QueueMessage<unknown>) => Promise<void>;
        const queue = {
            subscribe: async (_queue: unknown, handler: typeof consume) => {
                consume = handler;
                return async () => {};
            },
        } as unknown as QueuePort;
        const handle = vi.fn(async () => {});
        const stop = await runWorker(
            queue,
            { queue: job.queue, consumerName: "canonical-fixture" },
            handle,
            { admission: new CanonicalSyncJobAdmission(f.storage) },
        );
        const message = {
            data: job,
            ack: vi.fn(async () => {}),
            nack: vi.fn(async () => {}),
            touch: async () => {},
        };
        await consume(message);
        expect(handle).toHaveBeenCalledOnce();
        commitRollbackFixture({
            storage: f.storage,
            chainId: 1,
            fromBlock: 102,
            owners: [
                { collectionId: f.collectionId, tokenId: "1", owner: OWNER },
            ],
        });
        await consume(message);
        expect(handle).toHaveBeenCalledOnce();
        expect(message.ack).toHaveBeenCalledTimes(2);
        expect(message.nack).not.toHaveBeenCalled();
        await stop();
    });
});

function count(table: string): number {
    return (
        db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }
    ).n;
}
