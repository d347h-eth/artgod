import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { db, setDbPath } from "@artgod/shared/database";
import { createMigrationRunner } from "@artgod/shared/migrations";
import { COLLECTION_STATUS } from "@artgod/shared/types";
import { encodeEventTopics } from "viem";
import { ERC721_ABI } from "../src/abi/index.js";
import {
    SyncGapScheduler,
    executeSyncGapRepair,
} from "../src/application/sync-gap-scheduler.js";
import {
    processRange,
    publishDomainJobs,
} from "../src/application/sync-range-processing.js";
import {
    planSyncGapRepairBatches,
    remainingSyncGapRepairRange,
} from "../src/domain/sync-gap-repair.js";
import { DOMAIN_JOB_KIND } from "../src/domain/domain-jobs.js";
import { GLOBAL_MAKER_TRIGGER_REASON } from "../src/domain/maker-triggers.js";
import {
    MAKER_TRIGGER_SCOPE,
    ORDER_JOB_KIND,
} from "../src/domain/order-jobs.js";
import type { JobEnvelope } from "../src/domain/jobs.js";
import { QUEUE_NAMES } from "../src/domain/queues.js";
import {
    BACKFILL_ORDER_MAINTENANCE_POLICY,
    BACKFILL_SOURCE,
    type GapRepairSyncPayload,
    type SyncGapRepairTarget,
} from "../src/domain/sync-jobs.js";
import type { Hex, RpcLog, RpcProviderPort } from "../src/ports/rpc.js";
import type { QueuePort } from "../src/ports/queue.js";
import { SqliteCollectionRegistry } from "../src/infra/collections/sqlite.js";
import { SqliteSyncGapStore } from "../src/infra/storage/sqlite-sync-gaps.js";
import { SqliteStorage } from "../src/infra/storage/sqlite.js";
import { syncBlockFixture as block } from "./helpers/chain-fixture.js";
import {
    insertCollection,
    selectBalanceOwners,
    selectTransferCount,
} from "./helpers/ownership-fixture.js";
import { createTempDbPath } from "./helpers/test-helpers.js";
import { loadTestEnv } from "./helpers/test-env.js";

const CONTRACTS = [
    "0x1111111111111111111111111111111111111111",
    "0x2222222222222222222222222222222222222222",
    "0x3333333333333333333333333333333333333333",
] as const;
const SELLER = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const BUYER = "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
const TX = `0x${"ab".repeat(32)}` as Hex;
type RepairJob = JobEnvelope<GapRepairSyncPayload>;

describe("shared collection gap acquisition", () => {
    loadTestEnv();
    beforeAll(async () => {
        setDbPath(await createTempDbPath());
        await createMigrationRunner().runMigrations();
    });
    beforeEach(() =>
        db.exec(
            "DELETE FROM collections; DELETE FROM blocks; DELETE FROM transactions;",
        ),
    );

    it("fetches one range and one shared receipt, writes separate coverage and owners, and scopes fanout", async () => {
        const h = harness();
        const first = seed(0),
            second = seed(1),
            unrelated = seed(2);
        cover(first, 100, 100);
        cover(second, 100, 100);
        cover(unrelated, 100, 110);
        await h.scheduler.scan(110);
        expect(h.jobs).toHaveLength(1);
        const job = h.jobs[0];
        expect(job.collectionId).toBeUndefined();
        expect(
            job.payload.repairs!.map((target) => target.collectionId),
        ).toEqual([first, second]);
        const logs = CONTRACTS.slice(0, 2).map(
            (address, logIndex): RpcLog => ({
                address,
                data: "0x",
                topics: encodeEventTopics({
                    abi: ERC721_ABI,
                    eventName: "Transfer",
                    args: { from: SELLER, to: BUYER, tokenId: 1n },
                }) as Hex[],
                blockNumber: 105,
                blockHash: block(105).hash,
                transactionHash: TX,
                logIndex,
            }),
        );
        const rpc = testRpc(logs);
        const published: JobEnvelope[] = [];
        await run(h, job, rpc, async (domainJob) => {
            published.push(domainJob);
        });
        expect(rpc.getBlock).toHaveBeenCalledTimes(11);
        expect(rpc.getBlock.mock.calls.map(([number]) => number)).toEqual([
            101, 102, 103, 104, 105, 106, 107, 108, 109, 110, 110,
        ]);
        expect(rpc.getLogs).toHaveBeenCalledTimes(4);
        expect(rpc.getLogs.mock.calls[0][0].address).toEqual(
            CONTRACTS.slice(0, 2),
        );
        expect(rpc.getTransaction).toHaveBeenCalledTimes(1);
        expect(rpc.getTransactionReceipt).toHaveBeenCalledExactlyOnceWith(TX, {
            fresh: true,
        });
        for (const id of [first, second]) {
            expect(coverage(id)).toBe(11);
            expect(selectBalanceOwners(1, id, "1")).toEqual([
                { owner: BUYER, amount: "1" },
            ]);
            expect(h.store.getProgress(1, id)?.pending).toBeNull();
            expect(
                published.filter(
                    (j) =>
                        j.collectionId === id &&
                        [
                            DOMAIN_JOB_KIND.ActivitySync,
                            DOMAIN_JOB_KIND.OrdersSync,
                            DOMAIN_JOB_KIND.MetadataSync,
                        ].includes(j.kind as never),
                ),
            ).toHaveLength(3);
        }
        expect(published.some((j) => j.collectionId === unrelated)).toBe(false);
        expect(
            published.some(
                (j) =>
                    j.kind === DOMAIN_JOB_KIND.ActivitySync &&
                    j.collectionId === undefined,
            ),
        ).toBe(false);
        for (const domainJob of published.filter((candidate) =>
            [
                DOMAIN_JOB_KIND.ActivitySync,
                DOMAIN_JOB_KIND.OrdersSync,
                DOMAIN_JOB_KIND.MetadataSync,
            ].includes(candidate.kind as never),
        ))
            expect(
                (domainJob.payload as { sourceJobId: string }).sourceJobId,
            ).toBe(job.jobId);
        expect(
            published.filter(
                (j) =>
                    j.kind === ORDER_JOB_KIND.UpdateByMaker &&
                    (j.payload as { scope: string }).scope ===
                        MAKER_TRIGGER_SCOPE.Global,
            ),
        ).toHaveLength(1);
        expect(await run(h, job, rpc)).toBe(false);
        expect(rpc.getBlock).toHaveBeenCalledTimes(11);
    });

    it("keeps a member at its anchor facts-only inside a shared current-state range", async () => {
        const h = harness();
        const first = seed(0),
            atAnchor = seed(1);
        db.prepare(
            "UPDATE collections SET bootstrap_anchor_block = 110 WHERE collection_id = ?",
        ).run(atAnchor);
        await h.scheduler.scan(110);
        expect(h.jobs).toHaveLength(1);
        const published: JobEnvelope[] = [];
        await run(h, h.jobs[0], testRpc(), async (job) => {
            published.push(job);
        });
        expect(
            published
                .filter((job) => job.collectionId === atAnchor)
                .map((job) => job.kind),
        ).toEqual([DOMAIN_JOB_KIND.ActivitySync]);
        expect(
            published.filter(
                (job) =>
                    job.collectionId === first &&
                    [
                        DOMAIN_JOB_KIND.ActivitySync,
                        DOMAIN_JOB_KIND.OrdersSync,
                        DOMAIN_JOB_KIND.MetadataSync,
                    ].includes(job.kind as never),
            ),
        ).toHaveLength(3);
        expect(coverage(first)).toBe(1);
        expect(coverage(atAnchor)).toBe(1);
        expect(h.store.getProgress(1, first)?.pending).toMatchObject({
            fromBlock: 101,
            toBlock: 109,
        });
        expect(h.store.getProgress(1, atAnchor)?.pending).toBeNull();
    });

    it("shares only the common pending suffix and retains the older unfinished range", async () => {
        const h = harness(10);
        const older = seed(0),
            newer = seed(1);
        cover(older, 100, 105);
        cover(newer, 100, 114);
        await h.scheduler.scan(115);
        const first = h.jobs[0];
        expect([first.payload.fromBlock, first.payload.toBlock]).toEqual([
            115, 115,
        ]);
        expect(first.payload.repairs).toHaveLength(2);
        const oldTarget = first.payload.repairs!.find(
            (target) => target.collectionId === older,
        )!;
        await run(h, first, testRpc());
        expect(h.store.getProgress(1, newer)?.pending).toBeNull();
        expect(h.store.getProgress(1, older)?.pending).toMatchObject({
            repairId: oldTarget.repairId,
            fromBlock: 106,
            toBlock: 114,
            retryAt: 1000,
        });
        // Publication responses and duplicate commits from the old range cannot
        // overwrite the remaining range, even though its repair identity survived.
        h.store.deferRetry(1, oldTarget, 999999);
        h.store.recordRepairProgress({
            chainId: 1,
            repair: oldTarget,
            remaining: null,
            retryAt: 0,
        });
        expect(h.store.getProgress(1, older)?.pending?.toBlock).toBe(114);
        expect(h.store.getProgress(1, older)?.pending?.retryAt).toBe(1000);
        expect(await run(h, first, testRpc())).toBe(false);
        h.restart();
        await h.scheduler.scan(115);
        const next = h.jobs[1];
        expect([next.payload.fromBlock, next.payload.toBlock]).toEqual([
            106, 114,
        ]);
        expect(next.jobId).not.toBe(first.jobId);
        await run(h, next, testRpc());
        expect(h.store.getProgress(1, older)?.pending).toBeNull();
        expect(coverage(older)).toBe(16);
        expect(coverage(newer)).toBe(16);
    });

    it("avoids reacquiring a busy covered peer while completing unequal gaps", async () => {
        const costs: Record<
            string,
            {
                headers: number;
                logs: number;
                transactions: number;
                receipts: number;
            }
        > = {};
        for (const mode of ["separate", "shared"]) {
            db.exec(
                "DELETE FROM collections; DELETE FROM blocks; DELETE FROM transactions;",
            );
            const h = harness();
            const first = seed(0),
                busy = seed(1);
            cover(first, 100, 100);
            cover(busy, 100, 100);
            const logs = Array.from({ length: 9 }, (_, i) =>
                transferLog(1, 101 + i, BigInt(i + 1)),
            );
            logs.push(transferLog(0, 110, 10n));
            const rpc = testRpc(logs);
            const storage = new SqliteStorage();
            await processRange({
                rpc,
                storage,
                collectionScopeResolver: h.registry,
                collectionExtensions: { getInstall: () => null },
                chainId: 1,
                collections: [h.registry.getCollection(1, busy)!],
                range: { fromBlock: 101, toBlock: 109 },
                bidderIndex: { isActive: () => false, shouldEmit: () => false },
                wethAddress: CONTRACTS[0],
                orderMaintenancePolicy:
                    BACKFILL_ORDER_MAINTENANCE_POLICY.CurrentState,
            });
            rpc.getBlock.mockClear();
            rpc.getLogs.mockClear();
            rpc.getTransaction.mockClear();
            rpc.getTransactionReceipt.mockClear();
            await h.scheduler.scan(110);
            const firstBatch = h.jobs[0];
            expect([
                firstBatch.payload.fromBlock,
                firstBatch.payload.toBlock,
            ]).toEqual([110, 110]);
            const published: JobEnvelope[] = [];
            if (mode === "shared") {
                await run(h, firstBatch, rpc, async (job) => {
                    published.push(job);
                });
                expect(h.store.getProgress(1, busy)?.pending).toBeNull();
                expect(h.store.getProgress(1, first)?.pending).toMatchObject({
                    fromBlock: 101,
                    toBlock: 109,
                });
                h.restart();
                await h.scheduler.scan(110);
                const remainder = h.jobs[1];
                expect(
                    remainder.payload.repairs!.map(
                        (repair) => repair.collectionId,
                    ),
                ).toEqual([first]);
                await run(h, remainder, rpc, async (job) => {
                    published.push(job);
                });
                expect(
                    published
                        .filter(
                            (job) =>
                                job.kind === DOMAIN_JOB_KIND.ActivitySync &&
                                job.collectionId === busy,
                        )
                        .map((job) => job.payload),
                ).toEqual([
                    expect.objectContaining({ fromBlock: 110, toBlock: 110 }),
                ]);
            } else {
                for (const target of firstBatch.payload.repairs!)
                    await run(
                        h,
                        {
                            ...firstBatch,
                            jobId: `${firstBatch.jobId}:${target.collectionId}`,
                            payload: {
                                ...firstBatch.payload,
                                fromBlock: target.fromBlock,
                                toBlock: target.toBlock,
                                repairs: [target],
                            },
                        },
                        rpc,
                    );
            }
            for (const id of [first, busy]) {
                expect(h.store.getProgress(1, id)?.pending).toBeNull();
                expect(coverage(id)).toBe(11);
            }
            for (let token = 1; token <= 9; token++) {
                expect(selectBalanceOwners(1, busy, String(token))).toEqual([
                    { owner: BUYER, amount: "1" },
                ]);
                expect(selectTransferCount(1, busy, String(token))).toBe(1);
            }
            expect(selectBalanceOwners(1, first, "10")).toEqual([
                { owner: BUYER, amount: "1" },
            ]);
            expect(rpc.getTransaction.mock.calls.map(([hash]) => hash)).toEqual(
                [logs[9].transactionHash],
            );
            expect(rpc.getTransactionReceipt).toHaveBeenCalledExactlyOnceWith(
                logs[9].transactionHash,
                { fresh: true },
            );
            costs[mode] = {
                headers: rpc.getBlock.mock.calls.length,
                logs: rpc.getLogs.mock.calls.length,
                transactions: rpc.getTransaction.mock.calls.length,
                receipts: rpc.getTransactionReceipt.mock.calls.length,
            };
        }
        expect(costs).toEqual({
            separate: { headers: 13, logs: 8, transactions: 1, receipts: 1 },
            shared: { headers: 12, logs: 8, transactions: 1, receipts: 1 },
        });
    });

    it("finishes a previously queued widened batch using its original member intents", async () => {
        const h = harness();
        const first = seed(0),
            second = seed(1);
        cover(first, 100, 100);
        cover(second, 100, 109);
        await h.scheduler.scan(110);
        const current = h.jobs[0];
        const retained = {
            ...current,
            jobId: `${current.jobId}:retained`,
            payload: { ...current.payload, fromBlock: 101 },
        };
        expect(await run(h, retained, testRpc())).toBe(true);
        expect(h.store.getProgress(1, first)?.pending).toBeNull();
        expect(h.store.getProgress(1, second)?.pending).toBeNull();
        expect(coverage(first)).toBe(11);
        expect(coverage(second)).toBe(11);
    });

    it("keeps the whole batch pending after partial fanout, then retries the same identities after restart", async () => {
        const h = harness();
        const first = seed(0),
            second = seed(1);
        await h.scheduler.scan(110);
        const job = h.jobs[0];
        const failed = vi.fn(async (domainJob: JobEnvelope) => {
            if (
                domainJob.collectionId === second &&
                domainJob.kind === DOMAIN_JOB_KIND.OrdersSync
            )
                throw new Error("fanout unavailable");
        });
        await expect(run(h, job, testRpc(), failed)).rejects.toThrow(
            "fanout unavailable",
        );
        for (const id of [first, second]) {
            expect(coverage(id)).toBe(10);
            expect(h.store.getProgress(1, id)?.pending).not.toBeNull();
        }
        h.restart();
        h.advance();
        await h.scheduler.scan(110);
        expect(h.jobs[1]).toMatchObject({
            jobId: job.jobId,
            payload: job.payload,
        });
        const successful = vi.fn(async (_job: JobEnvelope) => {});
        await run(h, h.jobs[1], testRpc(), successful);
        expect(successful.mock.calls.slice(0, 3).map(([j]) => j.jobId)).toEqual(
            failed.mock.calls.slice(0, 3).map(([j]) => j.jobId),
        );
        expect(h.store.getProgress(1, first)?.pending).toBeNull();
        expect(h.store.getProgress(1, second)?.pending).toBeNull();
    });

    it.each(["pause", "anchor", "purge", "complete"])(
        "excludes a %s member at execution and leaves other members repairable",
        async (change) => {
            const h = harness();
            const first = seed(0),
                second = seed(1);
            await h.scheduler.scan(110);
            const job = h.jobs[0];
            const target = job.payload.repairs!.find(
                (repair) => repair.collectionId === second,
            )!;
            if (change === "pause")
                db.prepare(
                    "UPDATE collections SET status = ? WHERE collection_id = ?",
                ).run(COLLECTION_STATUS.Paused, second);
            if (change === "anchor")
                db.prepare(
                    "UPDATE collections SET bootstrap_anchor_block = 105 WHERE collection_id = ?",
                ).run(second);
            if (change === "purge")
                db.prepare(
                    "DELETE FROM collections WHERE collection_id = ?",
                ).run(second);
            if (change === "complete")
                h.store.recordRepairProgress({
                    chainId: 1,
                    repair: target,
                    remaining: null,
                    retryAt: 0,
                });
            const rpc = testRpc();
            const fanout = vi.fn(async (_job: JobEnvelope) => {});
            await run(h, job, rpc, fanout);
            expect(rpc.getLogs.mock.calls[0][0].address).toBe(CONTRACTS[0]);
            expect(coverage(first)).toBe(10);
            expect(coverage(second)).toBe(0);
            expect(
                fanout.mock.calls.some(([j]) => j.collectionId === second),
            ).toBe(false);
        },
    );

    it("consumes retained single-collection deliveries from the previous runtime", async () => {
        const h = harness();
        const id = seed(0);
        await h.scheduler.scan(110);
        const batch = h.jobs[0],
            target = batch.payload.repairs![0];
        const legacy = {
            ...batch,
            jobId: target.repairId,
            collectionId: id,
            payload: { ...batch.payload, repairs: undefined },
        };
        expect(await run(h, legacy, testRpc())).toBe(true);
        expect(h.store.getProgress(1, id)?.pending).toBeNull();
    });

    it("does not lose either repair on RPC failure and rejects ambiguous batch membership", async () => {
        const h = harness();
        const first = seed(0),
            second = seed(1);
        await h.scheduler.scan(110);
        const job = h.jobs[0],
            rpc = testRpc();
        rpc.getBlock.mockRejectedValueOnce(new Error("RPC unavailable"));
        await expect(run(h, job, rpc)).rejects.toThrow("RPC unavailable");
        expect(coverage(first)).toBe(0);
        expect(coverage(second)).toBe(0);
        for (const malformed of [
            { ...job, collectionId: first },
            {
                ...job,
                payload: {
                    ...job.payload,
                    repairs: [job.payload.repairs![0], job.payload.repairs![0]],
                },
            },
            {
                ...job,
                payload: { ...job.payload, toBlock: job.payload.toBlock - 1 },
            },
        ])
            expect(await run(h, malformed, testRpc())).toBe(false);
        expect(h.store.getProgress(1, first)?.pending).not.toBeNull();
        expect(h.store.getProgress(1, second)?.pending).not.toBeNull();
    });
});

describe("bounded gap batch planning", () => {
    it("covers every pending block exactly once without widening across all small interval combinations", () => {
        const intervals: Array<{ fromBlock: number; toBlock: number }> = [];
        for (let fromBlock = 1; fromBlock <= 4; fromBlock++)
            for (let toBlock = fromBlock; toBlock <= 4; toBlock++)
                intervals.push({ fromBlock, toBlock });
        for (const first of intervals)
            for (const second of intervals)
                for (const third of intervals) {
                    for (let cap = 1; cap <= 3; cap++) {
                        const original = [first, second, third].map(
                            (range, i): SyncGapRepairTarget => ({
                                ...range,
                                collectionId: i + 1,
                                repairId: String(i + 1),
                                anchorBlock: 1,
                            }),
                        );
                        let pending = original;
                        const served = new Map(
                            original.map((target) => [
                                target.collectionId,
                                [] as number[],
                            ]),
                        );
                        for (let pass = 0; pending.length; pass++) {
                            expect(pass).toBeLessThan(4);
                            const batches = planSyncGapRepairBatches(
                                pending,
                                cap,
                            );
                            expect(
                                planSyncGapRepairBatches(
                                    [...pending].reverse(),
                                    cap,
                                ),
                            ).toEqual(batches);
                            const admitted = batches.flatMap((batch) =>
                                batch.repairs.map(
                                    (target) => target.collectionId,
                                ),
                            );
                            expect(admitted).toHaveLength(pending.length);
                            expect(new Set(admitted)).toEqual(
                                new Set(
                                    pending.map(
                                        (target) => target.collectionId,
                                    ),
                                ),
                            );
                            const next: SyncGapRepairTarget[] = [];
                            for (const batch of batches) {
                                expect(
                                    batch.toBlock - batch.fromBlock + 1,
                                ).toBeLessThanOrEqual(cap);
                                for (const target of batch.repairs) {
                                    expect(
                                        batch.fromBlock,
                                    ).toBeGreaterThanOrEqual(target.fromBlock);
                                    expect(batch.toBlock).toBe(target.toBlock);
                                    for (
                                        let number = batch.fromBlock;
                                        number <= batch.toBlock;
                                        number++
                                    )
                                        served
                                            .get(target.collectionId)!
                                            .push(number);
                                    const remaining =
                                        remainingSyncGapRepairRange(
                                            target,
                                            batch.fromBlock,
                                        );
                                    if (remaining)
                                        next.push({ ...target, ...remaining });
                                }
                            }
                            pending = next;
                        }
                        for (const target of original)
                            expect(
                                served
                                    .get(target.collectionId)!
                                    .sort((a, b) => a - b),
                            ).toEqual(
                                Array.from(
                                    {
                                        length:
                                            target.toBlock -
                                            target.fromBlock +
                                            1,
                                    },
                                    (_, i) => target.fromBlock + i,
                                ),
                            );
                    }
                }
    });

    it("shares a common suffix only when upper bounds match, within the block bound", () => {
        const target = (
            collectionId: number,
            fromBlock: number,
            toBlock: number,
        ): SyncGapRepairTarget => ({
            collectionId,
            repairId: String(collectionId),
            anchorBlock: 1,
            fromBlock,
            toBlock,
        });
        const batches = planSyncGapRepairBatches(
            [
                target(1, 90, 99),
                target(2, 95, 104),
                target(3, 100, 109),
                target(4, 120, 122),
                target(5, 103, 109),
            ],
            10,
        );
        expect(
            batches.map((batch) => [
                batch.fromBlock,
                batch.toBlock,
                batch.repairs.map((repair) => repair.collectionId),
            ]),
        ).toEqual([
            [120, 122, [4]],
            [103, 109, [3, 5]],
            [95, 104, [2]],
            [90, 99, [1]],
        ]);
        for (const batch of batches) {
            expect(batch.toBlock - batch.fromBlock + 1).toBeLessThanOrEqual(10);
            for (const member of batch.repairs) {
                expect(batch.fromBlock).toBeGreaterThanOrEqual(
                    member.fromBlock,
                );
                expect(batch.toBlock).toBe(member.toBlock);
            }
        }
    });
});

function harness(batchSize = 10) {
    const registry = new SqliteCollectionRegistry(),
        store = new SqliteSyncGapStore();
    const jobs: RepairJob[] = [];
    const queue = {
        publish: vi.fn<QueuePort["publish"]>(async (_queue, job) => {
            jobs.push(job as RepairJob);
        }),
    };
    let now = 1000;
    const create = () =>
        new SyncGapScheduler(registry, store, queue, {
            chainId: 1,
            batchSize,
            now: () => now,
            retryDelayMs: 100,
        });
    return {
        registry,
        store,
        jobs,
        scheduler: create(),
        restart() {
            this.scheduler = create();
        },
        advance() {
            now += 100;
        },
        now: () => now,
    };
}

async function run(
    h: ReturnType<typeof harness>,
    job: RepairJob,
    rpc: ReturnType<typeof testRpc>,
    publish: (job: JobEnvelope) => Promise<void> = async () => {},
) {
    return executeSyncGapRepair(
        job,
        h.registry,
        h.store,
        async (collections, sources) => {
            const range = {
                fromBlock: job.payload.fromBlock,
                toBlock: job.payload.toBlock,
            };
            const { data } = await processRange({
                rpc,
                storage: new SqliteStorage(),
                collectionScopeResolver: h.registry,
                collectionExtensions: { getInstall: () => null },
                chainId: 1,
                collections,
                range,
                bidderIndex: { isActive: () => false, shouldEmit: () => false },
                wethAddress: CONTRACTS[0],
                orderMaintenancePolicy:
                    BACKFILL_ORDER_MAINTENANCE_POLICY.CurrentState,
            });
            data.global.makerTriggers.push({
                maker: SELLER,
                reason: GLOBAL_MAKER_TRIGGER_REASON.OrderCounter,
                blockNumber: job.payload.toBlock,
                blockHash: block(job.payload.toBlock).hash,
                txHash: TX,
                logIndex: 10,
            });
            await publishDomainJobs(
                {
                    publish: async (_queue, domainJob) => publish(domainJob),
                },
                1,
                collections,
                range,
                sources,
                "backfill",
                data,
                job.payload.orderMaintenancePolicy,
            );
        },
        h.now,
    );
}

function testRpc(logs: RpcLog[] = []) {
    return {
        getBlockNumber: async () => 115,
        getBlock: vi.fn(async (number: number) => block(number)),
        getLogs: vi.fn<RpcProviderPort["getLogs"]>(async (filter) => {
            if (
                !filter.events?.some(
                    (event) => event.name === ERC721_ABI[0].name,
                )
            )
                return [];
            const addresses = Array.isArray(filter.address)
                ? filter.address
                : [filter.address];
            return logs.filter(
                (log) =>
                    addresses.includes(log.address) &&
                    log.blockNumber >= filter.fromBlock &&
                    log.blockNumber <= filter.toBlock,
            );
        }),
        getTransaction: vi.fn<RpcProviderPort["getTransaction"]>(
            async (hash) => ({
                hash: hash as Hex,
                from: SELLER,
                to: CONTRACTS[0],
                input: "0x" as Hex,
            }),
        ),
        getTransactionReceipt: vi.fn<RpcProviderPort["getTransactionReceipt"]>(
            async (hash) => ({
                transactionHash: hash as Hex,
                logs: logs.filter((log) => log.transactionHash === hash),
            }),
        ),
        readContract: async () => {
            throw new Error("Unexpected contract read");
        },
        readContractAtBlock: async () => {
            throw new Error("Unexpected exact-block read");
        },
        getBalance: async () => 0n,
    } satisfies RpcProviderPort;
}

function seed(index: number) {
    return insertCollection({
        chainId: 1,
        slug: `batch-${index}`,
        address: CONTRACTS[index],
        anchorBlock: 100,
    });
}
function cover(collectionId: number, from: number, to: number) {
    const stmt = db.prepare(
        "INSERT OR IGNORE INTO collection_sync_blocks (chain_id, collection_id, block_number) VALUES (1, ?, ?)",
    );
    db.writeTransaction(() => {
        for (let number = from; number <= to; number++)
            stmt.run(collectionId, number);
    })();
}
function transferLog(index: number, number: number, tokenId: bigint): RpcLog {
    return {
        address: CONTRACTS[index],
        data: "0x",
        topics: encodeEventTopics({
            abi: ERC721_ABI,
            eventName: "Transfer",
            args: { from: SELLER, to: BUYER, tokenId },
        }) as Hex[],
        blockNumber: number,
        blockHash: block(number).hash,
        transactionHash: `0x${number.toString(16).padStart(64, "0")}` as Hex,
        logIndex: 0,
    };
}
function coverage(collectionId: number) {
    return (
        db
            .prepare(
                "SELECT COUNT(*) AS count FROM collection_sync_blocks WHERE collection_id = ?",
            )
            .get(collectionId) as { count: number }
    ).count;
}
