import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { db, setDbPath } from "@artgod/shared/database";
import { createMigrationRunner } from "@artgod/shared/migrations";
import { COLLECTION_STATUS } from "@artgod/shared/types";
import { encodeEventTopics } from "viem";
import { ERC721_ABI } from "../src/abi/index.js";
import { SyncGapScheduler } from "../src/application/sync-gap-scheduler.js";
import { acquireSyncRange } from "../src/application/sync-range-processing.js";
import {
    planSyncGapRepairBatches,
    remainingSyncGapRepairRange,
} from "../src/domain/sync-gap-repair.js";
import { DOMAIN_JOB_KIND } from "../src/domain/domain-jobs.js";
import type { JobEnvelope } from "../src/domain/jobs.js";
import { QUEUE_NAMES } from "../src/domain/queues.js";
import {
    BACKFILL_ORDER_MAINTENANCE_POLICY,
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
import { AutomaticSyncExecutor } from "../src/application/automatic-sync-executor.js";
import { BackfillExecutionGate } from "../src/application/backfill-execution.js";
import { drainQueueOutbox } from "../src/application/queue-outbox/drainer.js";
import { SqliteQueueOutbox } from "../src/infra/queue/sqlite-queue-outbox.js";
import { SqliteReorgRecoveries } from "../src/infra/storage/sqlite-reorg-recoveries.js";
import { SqliteSyncRangeCommit } from "../src/infra/storage/sqlite-sync-range-commit.js";

describe("shared collection gap acquisition", () => {
    loadTestEnv();
    beforeAll(async () => {
        setDbPath(await createTempDbPath());
        await createMigrationRunner().runMigrations();
    });
    beforeEach(() =>
        db.exec(
            "DELETE FROM collections; DELETE FROM blocks; DELETE FROM transactions; DELETE FROM queue_outbox; DELETE FROM chain_reorg_recoveries;",
        ),
    );

    it("acquires one range and shared receipt, retains separate coverage, owners and scoped follow-ups", async () => {
        const h = harness(),
            first = seed(0),
            second = seed(1),
            unrelated = seed(2);
        cover(first, 100, 100);
        cover(second, 100, 100);
        cover(unrelated, 100, 110);
        await h.scheduler.scan(110);
        const batch = h.batches()[0];
        expect(batch.repairs.map((r) => r.collectionId)).toEqual([
            first,
            second,
        ]);
        const logs = CONTRACTS.slice(0, 2).map(
            (address, logIndex): RpcLog => ({
                ...transferLog(logIndex, 105, 1n),
                address,
                transactionHash: TX,
                logIndex,
            }),
        );
        const rpc = testRpc(logs),
            published: JobEnvelope[] = [];
        await run(h, rpc, async (job) => {
            published.push(job);
        });
        expect(rpc.getBlock.mock.calls.map(([n]) => n)).toEqual([
            101, 102, 103, 104, 105, 106, 107, 108, 109, 110, 110,
        ]);
        expect(rpc.getLogs).toHaveBeenCalledTimes(4);
        expect(rpc.getLogs.mock.calls[0][0].address).toEqual(
            CONTRACTS.slice(0, 2),
        );
        expect(rpc.getTransaction).toHaveBeenCalledOnce();
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
            const source = `${batch.repairs.find((r) => r.collectionId === id)!.repairId}:range:101-110`;
            expect(
                published
                    .filter(
                        (j) =>
                            j.collectionId === id &&
                            [
                                DOMAIN_JOB_KIND.ActivitySync,
                                DOMAIN_JOB_KIND.OrdersSync,
                                DOMAIN_JOB_KIND.MetadataSync,
                            ].includes(j.kind as never),
                    )
                    .every(
                        (j) =>
                            (j.payload as { sourceJobId: string })
                                .sourceJobId === source,
                    ),
            ).toBe(true);
        }
        expect(published.some((j) => j.collectionId === unrelated)).toBe(false);
        await run(h, rpc);
        expect(rpc.getBlock).toHaveBeenCalledTimes(11);
    });

    it("keeps a collection at its anchor facts-only inside the shared range", async () => {
        const h = harness(),
            first = seed(0),
            atAnchor = seed(1);
        db.prepare(
            "UPDATE collections SET bootstrap_anchor_block = 110 WHERE collection_id = ?",
        ).run(atAnchor);
        await h.scheduler.scan(110);
        const published: JobEnvelope[] = [];
        await run(h, testRpc(), async (job) => {
            published.push(job);
        });
        expect(
            published
                .filter((j) => j.collectionId === atAnchor)
                .map((j) => j.kind),
        ).toEqual([DOMAIN_JOB_KIND.ActivitySync]);
        expect(published.filter((j) => j.collectionId === first)).toHaveLength(
            3,
        );
        expect(coverage(first)).toBe(1);
        expect(coverage(atAnchor)).toBe(1);
        expect(h.store.getProgress(1, first)?.pending).toMatchObject({
            fromBlock: 101,
            toBlock: 109,
        });
        expect(h.store.getProgress(1, atAnchor)?.pending).toBeNull();
    });

    it("shares only the common suffix and retains the older unfinished intent", async () => {
        const h = harness(),
            older = seed(0),
            newer = seed(1);
        cover(older, 100, 105);
        cover(newer, 100, 114);
        await h.scheduler.scan(115);
        const batch = h.batches()[0],
            old = batch.repairs.find((r) => r.collectionId === older)!;
        expect([batch.fromBlock, batch.toBlock]).toEqual([115, 115]);
        await run(h, testRpc());
        expect(h.store.getProgress(1, newer)?.pending).toBeNull();
        expect(h.store.getProgress(1, older)?.pending).toMatchObject({
            repairId: old.repairId,
            fromBlock: 106,
            toBlock: 114,
            retryAt: 1000,
        });
        h.store.deferRetry(1, old, 999999);
        expect(
            h.store.recordRepairProgress({
                chainId: 1,
                repair: old,
                remaining: null,
                retryAt: 0,
            }),
        ).toBe(false);
        expect(h.store.getProgress(1, older)?.pending?.retryAt).toBe(1000);
        h.restart();
        await h.scheduler.scan(115);
        expect(h.batches()[0]).toMatchObject({ fromBlock: 106, toBlock: 114 });
        await run(h, testRpc());
        expect(h.store.getProgress(1, older)?.pending).toBeNull();
        expect(coverage(older)).toBe(16);
        expect(coverage(newer)).toBe(16);
    });

    it("avoids rereading covered busy peers for unequal gaps with fewer logical RPC calls", async () => {
        const costs: Record<
            string,
            {
                headers: number;
                logs: number;
                transactions: number;
                receipts: number;
                heads: number;
            }
        > = {};
        for (const mode of ["separate", "shared"]) {
            db.exec(
                "DELETE FROM collections; DELETE FROM blocks; DELETE FROM transactions; DELETE FROM queue_outbox;",
            );
            const h = harness(),
                first = seed(0),
                busy = seed(1);
            cover(first, 100, 100);
            cover(busy, 100, 100);
            const logs = Array.from({ length: 9 }, (_, i) =>
                transferLog(1, 101 + i, BigInt(i + 1)),
            );
            logs.push(transferLog(0, 110, 10n));
            const rpc = testRpc(logs);
            const covered = await acquireSyncRange({
                rpc,
                storage: h.storage,
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
            h.storage.persistSyncResult(covered);
            rpc.getBlock.mockClear();
            rpc.getLogs.mockClear();
            rpc.getTransaction.mockClear();
            rpc.getTransactionReceipt.mockClear();
            rpc.getBlockNumber.mockClear();
            await h.scheduler.scan(110);
            const published: JobEnvelope[] = [];
            if (mode === "shared") {
                await run(h, rpc, async (job) => {
                    published.push(job);
                });
                expect(h.store.getProgress(1, busy)?.pending).toBeNull();
                h.restart();
                await h.scheduler.scan(110);
                await run(h, rpc, async (job) => {
                    published.push(job);
                });
                expect(
                    published
                        .filter(
                            (j) =>
                                j.kind === DOMAIN_JOB_KIND.ActivitySync &&
                                j.collectionId === busy,
                        )
                        .map((j) => j.payload),
                ).toEqual([
                    expect.objectContaining({ fromBlock: 110, toBlock: 110 }),
                ]);
            } else {
                for (const id of [first, busy])
                    await run(h, rpc, async () => {}, id);
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
                heads: rpc.getBlockNumber.mock.calls.length,
            };
        }
        expect(costs).toEqual({
            separate: {
                headers: 13,
                logs: 8,
                transactions: 1,
                receipts: 1,
                heads: 2,
            },
            shared: {
                headers: 12,
                logs: 8,
                transactions: 1,
                receipts: 1,
                heads: 2,
            },
        });
    });

    it("completes acquisition despite partial publication, retaining the same follow-ups without repeating RPC", async () => {
        const h = harness(),
            first = seed(0),
            second = seed(1);
        await h.scheduler.scan(110);
        const rpc = testRpc();
        const failed = vi.fn(async (j: JobEnvelope) => {
            if (
                j.collectionId === second &&
                j.kind === DOMAIN_JOB_KIND.OrdersSync
            )
                throw new Error("fanout unavailable");
        });
        await run(h, rpc, failed);
        for (const id of [first, second]) {
            expect(coverage(id)).toBe(10);
            expect(h.store.getProgress(1, id)?.pending).toBeNull();
        }
        const oldCalls = rpc.getBlock.mock.calls.length;
        const failedJob = failed.mock.calls.find(
            ([j]) =>
                j.collectionId === second &&
                j.kind === DOMAIN_JOB_KIND.OrdersSync,
        )![0];
        h.restart();
        const accepted: JobEnvelope[] = [];
        await run(h, rpc, async (j) => {
            accepted.push(j);
        });
        expect(accepted.map((j) => j.jobId)).toEqual([failedJob.jobId]);
        expect(rpc.getBlock).toHaveBeenCalledTimes(oldCalls);
    });

    it.each(["pause", "anchor", "purge", "complete"])(
        "excludes a %s member before acquisition",
        async (change) => {
            const h = harness(),
                first = seed(0),
                second = seed(1);
            await h.scheduler.scan(110);
            const target = h
                .batches()[0]
                .repairs.find((r) => r.collectionId === second)!;
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
            const rpc = testRpc(),
                published: JobEnvelope[] = [];
            await run(h, rpc, async (j) => {
                published.push(j);
            });
            expect(rpc.getLogs.mock.calls[0][0].address).toBe(CONTRACTS[0]);
            expect(coverage(first)).toBe(10);
            expect(coverage(second)).toBe(0);
            expect(published.some((j) => j.collectionId === second)).toBe(
                false,
            );
        },
    );

    it("retains both intents and no partial facts on RPC failure", async () => {
        const h = harness(),
            first = seed(0),
            second = seed(1);
        await h.scheduler.scan(110);
        const rpc = testRpc();
        rpc.getBlock.mockRejectedValueOnce(new Error("RPC unavailable"));
        await run(h, rpc);
        expect(coverage(first)).toBe(0);
        expect(coverage(second)).toBe(0);
        expect(h.batches()).toEqual([]);
        h.advance();
        expect(h.batches()[0].repairs).toHaveLength(2);
        await run(h, rpc);
        expect(coverage(first)).toBe(10);
        expect(coverage(second)).toBe(10);
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
        store = new SqliteSyncGapStore(),
        storage = new SqliteStorage(),
        outbox = new SqliteQueueOutbox(),
        recoveries = new SqliteReorgRecoveries(storage);
    const commit = new SqliteSyncRangeCommit({
        storage,
        outbox,
        gaps: store,
        recoveries,
        collections: registry,
    });
    let now = 1000;
    const create = () =>
        new SyncGapScheduler(registry, store, {
            chainId: 1,
            batchSize,
            now: () => now,
        });
    return {
        registry,
        store,
        storage,
        outbox,
        recoveries,
        commit,
        batchSize,
        scheduler: create(),
        restart() {
            this.scheduler = create();
        },
        advance() {
            now += 100;
        },
        now: () => now,
        batches: () =>
            planSyncGapRepairBatches(
                store.listDueRepairsAtNewestPendingHeight({
                    chainId: 1,
                    now,
                    limit: 16,
                }),
                batchSize,
            ),
    };
}
async function run(
    h: ReturnType<typeof harness>,
    rpc: ReturnType<typeof testRpc>,
    publish: (job: JobEnvelope) => Promise<void> = async () => {},
    onlyCollection?: number,
) {
    const gaps =
        onlyCollection === undefined
            ? h.store
            : {
                  ...h.store,
                  getProgress: h.store.getProgress.bind(h.store),
                  saveProgress: h.store.saveProgress.bind(h.store),
                  findGap: h.store.findGap.bind(h.store),
                  findNewestGap: h.store.findNewestGap.bind(h.store),
                  listHeadRecheckCollectionIds:
                      h.store.listHeadRecheckCollectionIds.bind(h.store),
                  deferRetry: h.store.deferRetry.bind(h.store),
                  recordRepairProgress: h.store.recordRepairProgress.bind(
                      h.store,
                  ),
                  listDueRepairsAtNewestPendingHeight: (
                      input: Parameters<
                          SqliteSyncGapStore["listDueRepairsAtNewestPendingHeight"]
                      >[0],
                  ) => {
                      return h.store
                          .listDueRepairsAtNewestPendingHeight(input)
                          .filter((r) => r.collectionId === onlyCollection);
                  },
              };
    const executor = new AutomaticSyncExecutor({
        chainId: 1,
        rpc,
        storage: h.storage,
        commit: h.commit,
        collectionsPort: h.registry,
        collectionExtensions: { getInstall: () => null },
        gaps,
        headGapRecheck: h.scheduler,
        recoveries: h.recoveries,
        gate: new BackfillExecutionGate(),
        batchSize: h.batchSize,
        now: h.now,
        retryDelayMs: 100,
        bidderIndex: { isActive: () => false, shouldEmit: () => false },
        wethAddress: CONTRACTS[0],
    });
    await executor.runDue();
    await drainQueueOutbox(
        h.outbox,
        { publish: async (_queue, job) => publish(job) } as QueuePort,
        { retryBaseDelayMs: 0 },
    );
}

function testRpc(logs: RpcLog[] = []) {
    return {
        getBlockNumber: vi.fn(async () => 115),
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
