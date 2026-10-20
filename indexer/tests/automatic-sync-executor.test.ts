import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { db, setDbPath } from "@artgod/shared/database";
import { createMigrationRunner } from "@artgod/shared/migrations";
import { logger } from "@artgod/shared/utils";
import { SYNC_WORK_CLASS } from "@artgod/shared/types/sync-work-class";
import { RpcBudgetDeferred } from "@artgod/shared/evm/rpc-budget";
import { startAutomaticSyncLoop } from "../src/application/automatic-sync-executor.js";
import { ChainSyncConflict } from "../src/domain/chain-sync.js";
import { allocateOrderValidationAdmission } from "../src/infra/orders/sqlite-order-validation-demand.js";
import {
    COORDINATED_SYNC_FIXTURE as F,
    createCoordinatorFixture,
    installedCoordinatorCollection,
    retainInstalledCoordinatorBase,
} from "./helpers/coordinated-sync-fixture.js";
import { syncBlockFixture } from "./helpers/chain-fixture.js";
import { createTempDbPath } from "./helpers/test-helpers.js";
import { loadTestEnv } from "./helpers/test-env.js";

describe("ordered automatic sync coordinator", () => {
    loadTestEnv();
    let now: number;
    let databasePath: string;
    beforeEach(async () => {
        databasePath = await createTempDbPath();
        setDbPath(databasePath);
        await createMigrationRunner().runMigrations();
        now = 1_000;
        vi.spyOn(logger, "info").mockImplementation(() => {});
        vi.spyOn(logger, "warn").mockImplementation(() => {});
    });
    afterEach(() => vi.restoreAllMocks());

    async function drain(
        executor: { runDue(): Promise<boolean> },
        passes = 50,
    ) {
        for (let pass = 0; pass < passes; pass++)
            if (!(await executor.runDue())) return;
        throw new Error(
            "Coordinator did not become idle within the bounded fixture",
        );
    }

    it("applies 901 before 902 even when the retained target skips straight to 902", async () => {
        const s = createCoordinatorFixture({ now: () => now });
        s.sample(902);
        expect(await s.executor.runDue()).toBe(true);
        expect(s.progress.chainProgress(F.chainId)?.applied.number).toBe(901);
        expect(s.storage.getBlockHash(F.chainId, 902)).toBeNull();
        expect(
            s.progress.collectionProgress(F.chainId, s.collections[0]!.id)
                ?.applied.number,
        ).toBe(900);
        await drain(s.executor);
        expect(s.progress.chainProgress(F.chainId)?.applied.number).toBe(902);
        expect(
            s.progress.collectionProgress(F.chainId, s.collections[0]!.id)
                ?.applied.number,
        ).toBe(902);
        expect(
            s.remote.state.logReads.every(
                (range) => range.fromBlock === range.toBlock,
            ),
        ).toBe(true);
    });

    it("keeps shared and scoped catchup on the main lane when gap repair is disabled", async () => {
        const s = createCoordinatorFixture({
            now: () => now,
            gapWorkEnabled: false,
        });
        const classes: string[] = [];
        s.remote.state.beforeLogs = async () => {
            classes.push(s.workScope.current());
        };
        s.sample(904);
        await drain(s.executor);
        expect(new Set(classes)).toEqual(new Set([SYNC_WORK_CLASS.Main]));
        expect(s.historical.state.logReads).toHaveLength(0);
        expect(
            s.progress.validationCheckpoint(F.chainId, s.collections[0]!.id)
                ?.block.number,
        ).toBe(904);
        expect(s.gaps.getProgress(F.chainId, s.collections[0]!.id)).toBeNull();
    });

    it("holds a source admission until a later sample and both applied prefixes cover it", async () => {
        const s = createCoordinatorFixture({ now: () => now });
        s.sample(902);
        const sequence = db.writeTransaction(() =>
            allocateOrderValidationAdmission(F.chainId),
        )();
        expect(s.progress.admissionBarrier(F.chainId, sequence)).toBeNull();
        s.sample(902);
        const barrier = s.progress.admissionBarrier(F.chainId, sequence)!;
        expect(barrier.blockNumber).toBe(902);
        expect(
            s.progress.validationCheckpoint(
                F.chainId,
                s.collections[0]!.id,
                barrier,
            ),
        ).toBeNull();
        await s.executor.runDue(); // Shared 901.
        await s.executor.runDue(); // Collection 901.
        await s.executor.runDue(); // Shared 902 is insufficient by itself.
        expect(
            s.progress.validationCheckpoint(
                F.chainId,
                s.collections[0]!.id,
                barrier,
            ),
        ).toBeNull();
        await s.executor.runDue();
        expect(
            s.progress.validationCheckpoint(
                F.chainId,
                s.collections[0]!.id,
                barrier,
            )?.block.number,
        ).toBe(902);
    });

    it("does not let one failing collection starve another ready scope", async () => {
        const s = createCoordinatorFixture({
            now: () => now,
            collectionCount: 2,
        });
        const [failed, healthy] = s.collections;
        s.remote.state.beforeLogs = async (filter) => {
            if (filter.address === failed!.address)
                throw new Error("collection provider failure");
        };
        s.sample(902);
        await drain(s.executor);
        expect(s.progress.chainProgress(F.chainId)?.applied.number).toBe(902);
        expect(
            s.progress.collectionProgress(F.chainId, failed!.id)?.applied
                .number,
        ).toBe(900);
        expect(
            s.progress.collectionProgress(F.chainId, healthy!.id)?.applied
                .number,
        ).toBe(902);
        expect(
            db
                .prepare(
                    "SELECT retry_at FROM collection_sync_progress WHERE collection_id=?",
                )
                .get(failed!.id),
        ).toEqual({ retry_at: now + F.retryDelayMs });
        s.remote.state.beforeLogs = undefined;
        now += F.retryDelayMs;
        await drain(s.executor);
        expect(
            s.progress.collectionProgress(F.chainId, failed!.id)?.applied
                .number,
        ).toBe(902);
    });

    it("retains a failed shared range and its retry time across database reopening", async () => {
        const s = createCoordinatorFixture({ now: () => now });
        s.sample(902);
        s.remote.state.beforeLogs = async () => {
            throw new Error("provider offline");
        };
        expect(await s.executor.runDue()).toBe(true);
        expect(s.progress.chainProgress(F.chainId)?.applied.number).toBe(900);
        const calls = s.remote.state.logReads.length;
        db.raw.close();
        setDbPath(databasePath);
        const resumed = s.restart();
        expect(await resumed.executor.runDue()).toBe(false);
        expect(s.remote.state.logReads).toHaveLength(calls);
        s.remote.state.beforeLogs = undefined;
        now += F.retryDelayMs;
        await drain(resumed.executor);
        expect(
            resumed.progress.validationCheckpoint(
                F.chainId,
                s.collections[0]!.id,
            )?.block.number,
        ).toBe(902);
        expect(resumed.progress.headTarget(F.chainId)?.blockNumber).toBe(902);
    });

    it("accepts a fresh joining ownership base only after shared history reaches its anchor", async () => {
        const s = createCoordinatorFixture({ now: () => now });
        const joining = installedCoordinatorCollection("joining", 902);
        retainInstalledCoordinatorBase(joining.id, 902);
        s.sample(904);
        await s.executor.runDue();
        expect(s.progress.collectionProgress(F.chainId, joining.id)).toBeNull();
        await s.executor.runDue();
        expect(s.progress.collectionProgress(F.chainId, joining.id)).toBeNull();
        await s.executor.runDue();
        expect(s.progress.chainProgress(F.chainId)?.applied.number).toBe(902);
        await s.executor.runDue();
        expect(
            s.progress.collectionProgress(F.chainId, joining.id)?.anchor.number,
        ).toBe(902);
        await drain(s.executor);
        expect(
            s.progress.validationCheckpoint(F.chainId, joining.id)?.block
                .number,
        ).toBe(904);
        const reads = s.remote.state.logReads.filter(
            (filter) => filter.address === joining.address,
        );
        expect(reads.length).toBeGreaterThan(0);
        expect(reads.every((range) => range.fromBlock > 902)).toBe(true);
    });

    async function newerSharedBaseWithSlowCollection() {
        const s = createCoordinatorFixture({
            now: () => now,
            collectionCount: 0,
        });
        // Only the fast bootstrap has installed balances when shared startup runs.
        db.exec("DELETE FROM chain_sync_progress; DELETE FROM blocks;");
        const slow = installedCoordinatorCollection("slow-older", 898);
        const fast = installedCoordinatorCollection("fast-newer", 901);
        retainInstalledCoordinatorBase(fast.id, 901);
        s.sample(904);
        await drain(s.executor);
        retainInstalledCoordinatorBase(slow.id, 898);
        return { ...s, slow, fast };
    }

    it("joins an older late-installed collection prefix without lowering shared authority", async () => {
        const s = await newerSharedBaseWithSlowCollection();
        await s.executor.runDue(); // Accept 898; scoped 899.
        expect(
            s.progress.collectionProgress(F.chainId, s.slow.id)?.applied.number,
        ).toBe(899);
        expect(
            s.progress.validationCheckpoint(F.chainId, s.slow.id),
        ).toBeNull();
        expect(
            s.progress.validationCheckpoint(F.chainId, s.fast.id)?.block.number,
        ).toBe(904);
        await s.executor.runDue(); // Scoped 900 still has not joined shared base.
        expect(
            s.progress.validationCheckpoint(F.chainId, s.slow.id),
        ).toBeNull();
        await s.executor.runDue(); // Exact shared 901 joins both prefixes.
        expect(
            s.progress.validationCheckpoint(F.chainId, s.slow.id)?.block.number,
        ).toBe(901);
        await drain(s.executor);
        expect(
            s.progress.validationCheckpoint(F.chainId, s.slow.id)?.block.number,
        ).toBe(904);
        expect(s.progress.chainProgress(F.chainId)).toMatchObject({
            anchor: { number: 901 },
            applied: { number: 904 },
        });
        expect(s.historical.state.logReads).toHaveLength(0);
    });

    it("rejects an older collection's competing join and retains the shared dispute", async () => {
        const s = await newerSharedBaseWithSlowCollection();
        await s.executor.runDue();
        await s.executor.runDue();
        s.remote.state.headers.set(901, {
            ...syncBlockFixture(901),
            hash: `0x${"c".repeat(64)}`,
        });
        await s.executor.runDue();
        expect(
            s.progress.collectionProgress(F.chainId, s.slow.id)?.applied.number,
        ).toBe(900);
        expect(s.progress.chainProgress(F.chainId)?.anchor.number).toBe(901);
        expect(
            s.progress.validationCheckpoint(F.chainId, s.slow.id),
        ).toBeNull();
        expect(
            s.progress.validationCheckpoint(F.chainId, s.fast.id),
        ).toBeNull();
        expect(
            db
                .prepare(
                    "SELECT disputed_from FROM chain_sync_progress WHERE chain_id=?",
                )
                .get(F.chainId),
        ).toEqual({ disputed_from: 901 });
    });

    it("fences older-prefix acquisition when its collection base changes during RPC", async () => {
        const s = await newerSharedBaseWithSlowCollection();
        s.remote.state.beforeLogs = async (filter) => {
            if (filter.address === s.slow.address)
                db.prepare(
                    "UPDATE collections SET bootstrap_anchor_block=899 WHERE collection_id=?",
                ).run(s.slow.id);
        };
        await s.executor.runDue();
        expect(
            s.progress.collectionProgress(F.chainId, s.slow.id)?.applied.number,
        ).toBe(898);
        expect(s.storage.getBlockHash(F.chainId, 899)).toBeNull();
        expect(
            s.progress.validationCheckpoint(F.chainId, s.fast.id)?.block.number,
        ).toBe(904);
    });

    it("defers failed older-base verification while healthy applied scopes and another base progress", async () => {
        const s = await newerSharedBaseWithSlowCollection();
        const other = installedCoordinatorCollection("other-older", 899);
        retainInstalledCoordinatorBase(other.id, 899);
        s.remote.state.beforeBlock = async (number) => {
            if (number === 898) throw new Error("older anchor unavailable");
        };
        s.sample(905);
        await s.executor.runDue();
        expect(s.progress.collectionProgress(F.chainId, s.slow.id)).toBeNull();
        expect(
            db
                .prepare(
                    "SELECT retry_at FROM collection_ownership_bases WHERE collection_id=?",
                )
                .get(s.slow.id),
        ).toEqual({ retry_at: now + F.retryDelayMs });
        await drain(s.executor);
        expect(
            s.progress.validationCheckpoint(F.chainId, s.fast.id)?.block.number,
        ).toBe(905);
        expect(
            s.progress.validationCheckpoint(F.chainId, other.id)?.block.number,
        ).toBe(905);
        expect(
            s.remote.state.blockReads.filter((number) => number === 898),
        ).toHaveLength(1);
        // Retry eligibility survives adapter/database restart.
        db.raw.close();
        setDbPath(databasePath);
        const resumed = s.restart();
        expect(await resumed.executor.runDue()).toBe(false);
        s.remote.state.beforeBlock = undefined;
        now += F.retryDelayMs;
        await drain(resumed.executor);
        expect(
            resumed.progress.validationCheckpoint(F.chainId, s.slow.id)?.block
                .number,
        ).toBe(905);
    });

    it("retries a rejected candidate without advancing either prefix or publishing its facts", async () => {
        const s = createCoordinatorFixture({ now: () => now });
        s.sample(901);
        s.remote.state.headers.set(901, syncBlockFixture(902));
        expect(await s.executor.runDue()).toBe(true);
        expect(s.progress.chainProgress(F.chainId)?.applied.number).toBe(900);
        expect(
            s.progress.collectionProgress(F.chainId, s.collections[0]!.id)
                ?.applied.number,
        ).toBe(900);
        expect(
            db.prepare("SELECT COUNT(*) AS count FROM queue_outbox").get(),
        ).toEqual({ count: 0 });
        expect(s.storage.getBlockHash(F.chainId, 901)).toBeNull();
        s.remote.state.headers.delete(901);
        now += F.retryDelayMs;
        await drain(s.executor);
        expect(
            s.progress.validationCheckpoint(F.chainId, s.collections[0]!.id)
                ?.block.number,
        ).toBe(901);
    });

    it("gates validation immediately when collection replay disputes an accepted shared header", async () => {
        const s = createCoordinatorFixture({ now: () => now });
        s.remote.state.head = 901; // The accepted tip is not maturity-check due.
        s.sample(901);
        await s.executor.runDue(); // Shared 901, collection still 900.
        const original = syncBlockFixture(901);
        s.remote.state.headers.set(901, {
            ...original,
            hash: `0x${"a".repeat(64)}`,
        });
        await s.executor.runDue(); // Coherent competing child of accepted 900.
        expect(s.progress.chainProgress(F.chainId)?.applied.number).toBe(901);
        expect(
            s.progress.collectionProgress(F.chainId, s.collections[0]!.id)
                ?.applied.number,
        ).toBe(900);
        expect(
            s.progress.validationCheckpoint(F.chainId, s.collections[0]!.id),
        ).toBeNull();
        expect(
            db
                .prepare(
                    "SELECT canonical_check_disputed FROM blocks WHERE chain_id=? AND block_number=?",
                )
                .get(F.chainId, 901),
        ).toEqual({ canonical_check_disputed: 1 });
        expect(
            db.prepare("SELECT COUNT(*) AS count FROM queue_outbox").get(),
        ).toEqual({ count: 1 });

        // Only the recovery owner's fresh confirmation clears this dispute.
        s.remote.state.headers.delete(901);
        now += F.retryDelayMs;
        await drain(s.executor);
        expect(
            s.progress.validationCheckpoint(F.chainId, s.collections[0]!.id)
                ?.block.number,
        ).toBe(901);
        expect(
            db
                .prepare(
                    "SELECT canonical_check_disputed FROM blocks WHERE chain_id=? AND block_number=?",
                )
                .get(F.chainId, 901),
        ).toEqual({ canonical_check_disputed: 0 });
    });

    it("rolls back a range and its outbox when progress acceptance fails", async () => {
        const s = createCoordinatorFixture({ now: () => now });
        s.sample(901);
        const advance = vi
            .spyOn(s.progress, "advanceChain")
            .mockImplementationOnce(() => {
                throw new ChainSyncConflict("writer fence");
            });
        await s.executor.runDue();
        expect(s.storage.getBlockHash(F.chainId, 901)).toBeNull();
        expect(s.progress.chainProgress(F.chainId)?.applied.number).toBe(900);
        expect(
            db.prepare("SELECT COUNT(*) AS count FROM queue_outbox").get(),
        ).toEqual({ count: 0 });
        advance.mockRestore();
        now += F.retryDelayMs;
        await drain(s.executor);
        expect(s.progress.chainProgress(F.chainId)?.applied.number).toBe(901);
    });

    it("uses a deferred RPC budget delay without discarding the target", async () => {
        const s = createCoordinatorFixture({ now: () => now });
        s.sample(901);
        s.remote.state.beforeLogs = async () => {
            throw new RpcBudgetDeferred(200);
        };
        await s.executor.runDue();
        expect(
            db
                .prepare(
                    "SELECT retry_at FROM chain_sync_progress WHERE chain_id=?",
                )
                .get(F.chainId),
        ).toEqual({ retry_at: now + 200 });
        expect(s.progress.headTarget(F.chainId)?.blockNumber).toBe(901);
        expect(s.progress.chainProgress(F.chainId)?.applied.number).toBe(900);
    });

    it("coalesces concurrent passes and performs only one acquired range", async () => {
        const s = createCoordinatorFixture({ now: () => now });
        s.sample(904);
        let release!: () => void;
        let entered!: () => void;
        const waiting = new Promise<void>((resolve) => {
            entered = resolve;
        });
        const held = new Promise<void>((resolve) => {
            release = resolve;
        });
        s.remote.state.beforeLogs = async () => {
            entered();
            await held;
        };
        const first = s.executor.runDue();
        await waiting;
        const second = s.executor.runDue();
        expect(second).toBe(first);
        release();
        await Promise.all([first, second]);
        expect(s.progress.chainProgress(F.chainId)?.applied.number).toBe(901);
        expect(
            s.progress.collectionProgress(F.chainId, s.collections[0]!.id)
                ?.applied.number,
        ).toBe(900);
    });

    it("repairs retained history with the historical provider and leaves applied authority unchanged", async () => {
        const s = createCoordinatorFixture({
            now: () => now,
            gapWorkEnabled: true,
        });
        // An installed snapshot is an ownership base, not imported history at
        // the anchor. Foreground can finish before this older factual gap.
        s.sample(904);
        for (let pass = 0; pass < 8; pass++) await s.executor.runDue();
        const before = s.progress.validationCheckpoint(
            F.chainId,
            s.collections[0]!.id,
        );
        expect(before?.block.number).toBe(904);
        await drain(s.executor);
        expect(s.historical.state.logReads.length).toBeGreaterThan(0);
        expect(
            s.historical.state.logReads.every((range) => range.toBlock <= 900),
        ).toBe(true);
        expect(
            s.progress.validationCheckpoint(F.chainId, s.collections[0]!.id),
        ).toEqual(before);
        expect(
            s.storage.countCollectionSyncedBlocksInRange(
                F.chainId,
                s.collections[0]!.id,
                900,
                904,
            ),
        ).toBe(5);
    });

    it("keeps a failed historical gap across restart and retries only when due", async () => {
        const s = createCoordinatorFixture({
            now: () => now,
            gapWorkEnabled: true,
        });
        s.historical.state.beforeLogs = async () => {
            throw new Error("historical endpoint unavailable");
        };
        await drain(s.executor);
        expect(
            s.gaps.getProgress(F.chainId, s.collections[0]!.id)?.pending,
        ).toMatchObject({
            fromBlock: 900,
            toBlock: 900,
            retryAt: now + F.retryDelayMs,
        });
        db.raw.close();
        setDbPath(databasePath);
        const resumed = s.restart();
        const calls = s.historical.state.logReads.length;
        await drain(resumed.executor);
        expect(s.historical.state.logReads).toHaveLength(calls);
        s.historical.state.beforeLogs = undefined;
        now += F.retryDelayMs;
        await drain(resumed.executor);
        expect(
            resumed.gaps.getProgress(F.chainId, s.collections[0]!.id)?.pending,
        ).toBeNull();
        expect(resumed.progress.chainProgress(F.chainId)?.applied.number).toBe(
            900,
        );
    });

    it("finishes canonical rollback and ordered resync with gap repair disabled", async () => {
        const s = createCoordinatorFixture({
            now: () => now,
            gapWorkEnabled: false,
        });
        s.sample(904);
        await drain(s.executor);
        const fork = 902;
        for (let number = fork + 1; number <= 904; number++) {
            const block = syncBlockFixture(number);
            s.remote.state.headers.set(number, {
                ...block,
                hash: syncBlockFixture(number + 10_000).hash,
                parentHash:
                    number === fork + 1
                        ? syncBlockFixture(fork).hash
                        : syncBlockFixture(number - 1 + 10_000).hash,
            });
        }
        s.checks.retain(
            {
                chainId: F.chainId,
                checkpoint: s.storage.captureSyncCheckpoint(F.chainId),
                blockNumber: 904,
                blockHash: syncBlockFixture(904).hash,
            },
            { disputed: true },
        );
        expect(
            s.progress.validationCheckpoint(F.chainId, s.collections[0]!.id),
        ).toBeNull();
        await drain(s.executor);
        expect(s.recoveries.getRecovery(F.chainId)).toBeNull();
        expect(s.storage.captureSyncCheckpoint(F.chainId).revision).toBe(1);
        const replacement = s.remote.state.headers.get(904)!;
        expect(
            s.progress.validationCheckpoint(F.chainId, s.collections[0]!.id)
                ?.block,
        ).toMatchObject({ number: replacement.number, hash: replacement.hash });
        expect(s.historical.state.logReads).toHaveLength(0);
    });
});

describe("automatic sync loop lifecycle", () => {
    afterEach(() => vi.useRealTimers());

    it("wakes idle retained work without waiting for the poll timer", async () => {
        vi.useFakeTimers();
        const executor = { runDue: vi.fn(async () => false) };
        const loop = startAutomaticSyncLoop(executor, 10_000);
        await vi.advanceTimersByTimeAsync(0);
        expect(executor.runDue).toHaveBeenCalledTimes(1);
        loop.wake();
        await vi.advanceTimersByTimeAsync(0);
        expect(executor.runDue).toHaveBeenCalledTimes(2);
        await loop.stop();
        await vi.advanceTimersByTimeAsync(20_000);
        expect(executor.runDue).toHaveBeenCalledTimes(2);
    });

    it("waits for the active bounded range before stopping", async () => {
        let release!: (busy: boolean) => void;
        const executor = {
            runDue: vi.fn(
                () =>
                    new Promise<boolean>((resolve) => {
                        release = resolve;
                    }),
            ),
        };
        const loop = startAutomaticSyncLoop(executor);
        let stopped = false;
        const stop = loop.stop().then(() => {
            stopped = true;
        });
        await Promise.resolve();
        expect(stopped).toBe(false);
        release(true);
        await stop;
        expect(executor.runDue).toHaveBeenCalledTimes(1);
    });
});
