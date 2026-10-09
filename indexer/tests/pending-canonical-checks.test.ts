import { beforeEach, describe, expect, it, vi } from "vitest";
import { db, setDbPath } from "@artgod/shared/database";
import { createMigrationRunner } from "@artgod/shared/migrations";
import { canonicalCheckUpperBound } from "../src/domain/canonical-check.js";
import { ChainSyncConflict } from "../src/domain/chain-sync.js";
import { REORG_RECOVERY_PHASE } from "../src/domain/reorg-recovery.js";
import { startReorgRecoveryLoop } from "../src/application/reorg-recovery.js";
import { createTempDbPath } from "./helpers/test-helpers.js";
import { loadTestEnv } from "./helpers/test-env.js";
import {
    emptyOnChainData,
    transferFixture,
    selectBalanceOwners,
} from "./helpers/ownership-fixture.js";
import { syncBlockFixture as block } from "./helpers/chain-fixture.js";
import {
    RecoveryRpc,
    reorgRecoveryServices,
    REORG_FIXTURE as F,
} from "./helpers/reorg-recovery-fixture.js";
import { advanceChainSyncRevision } from "../src/infra/storage/sqlite-chain-revisions.js";
import { DOMAIN_JOB_KIND } from "../src/domain/domain-jobs.js";
import { BACKFILL_ORDER_MAINTENANCE_POLICY } from "../src/domain/sync-jobs.js";
import { SYNC_WORK_COMPLETION } from "../src/domain/sync-work.js";
import { buildSyncFollowUps } from "../src/application/sync-range-processing.js";

describe("DB-owned canonical hash checks", () => {
    loadTestEnv();
    let dbPath: string, now: number;
    beforeEach(async () => {
        dbPath = await createTempDbPath();
        setDbPath(dbPath);
        await createMigrationRunner().runMigrations();
        now = 1000;
    });
    function setup() {
        const rpc = new RecoveryRpc(1000);
        const s = reorgRecoveryServices(rpc, {
            now: () => now,
            retryDelayMs: 100,
        });
        const f = transferFixture();
        const collection = s.registry.getCollection(1, f.collectionId)!;
        function result(numbers: number[], head: number, depth = 3) {
            return {
                checkpoint: s.storage.captureSyncCheckpoint(1),
                canonicalCheck: { observedHeadBlock: head, reorgDepth: depth },
                blocks: numbers.map(block),
                collections: [collection],
                data: emptyOnChainData(),
            };
        }
        const due = (upperBound = Number.MAX_SAFE_INTEGER) =>
            s.checks.nextDue({ chainId: 1, now, upperBound });
        return { ...s, rpc, f, result, due };
    }

    it.each([1, 3, 32])(
        "retains only blocks fetched before the existing depth=%s threshold",
        (depth) => {
            const s = setup();
            s.storage.persistSyncResult(
                s.result([100, 101, 102, 103], 102 + depth - 1, depth),
            );
            expect(s.due()?.blockNumber).toBe(103);
            expect(canonicalCheckUpperBound(102 + depth - 1, depth)).toBe(102);
        },
    );

    it("does not publish, complete or lose a check before its recent block is saved", async () => {
        const s = setup();
        expect(await s.recovery.checkDue()).toBe(false);
        const header = vi.spyOn(s.rpc, "getBlock");
        s.storage.persistSyncResult(s.result([105], 105));
        vi.spyOn(s.rpc, "getBlockNumber").mockResolvedValue(106);
        expect(await s.recovery.checkDue()).toBe(false);
        expect(header).not.toHaveBeenCalled();
        expect(s.due()?.blockNumber).toBe(105);
        vi.mocked(s.rpc.getBlockNumber).mockResolvedValue(107);
        expect(await s.recovery.checkDue()).toBe(true);
        expect(header).toHaveBeenCalledExactlyOnceWith(105, { fresh: true });
        expect(s.due()).toBeNull();
    });

    it("survives restart and validates a block far outside the current realtime tail", async () => {
        const s = setup();
        s.storage.persistSyncResult(s.result([105], 105));
        db.raw.close();
        setDbPath(dbPath);
        const rpc = new RecoveryRpc(1000);
        vi.spyOn(rpc, "getBlockNumber").mockResolvedValue(1000);
        const restarted = reorgRecoveryServices(rpc, { now: () => now });
        const header = vi.spyOn(rpc, "getBlock");
        expect(await restarted.recovery.checkDue()).toBe(true);
        expect(header).toHaveBeenCalledExactlyOnceWith(105, { fresh: true });
        expect(restarted.checks.hasPending(1, now)).toBe(false);
    });

    it("detects and rolls back an interrupted shallow reorg after its check ages beyond the tail", async () => {
        const s = setup();
        s.storage.persistSyncResult(s.result([F.Anchor, F.Fork], 200));
        const recent = s.result([F.Orphan], F.Orphan);
        recent.data.collectionScoped.nftTransferEvents.push(
            s.f.transfer(F.Orphan, 1, F.Owner, F.OrphanOwner),
        );
        s.storage.persistSyncResult(recent);
        expect(selectBalanceOwners(1, s.f.collectionId, "1")).toEqual([
            { owner: F.OrphanOwner, amount: "1" },
        ]);
        db.raw.close();
        setDbPath(dbPath);
        const rpc = new RecoveryRpc(F.Fork, 1000);
        const restarted = reorgRecoveryServices(rpc, { now: () => now });
        expect(await restarted.recovery.checkDue()).toBe(true);
        expect(restarted.recoveries.getRecovery(1)).toMatchObject({
            phase: REORG_RECOVERY_PHASE.Resync,
            checkedBlock: F.Orphan,
            fromBlock: F.Orphan,
            targetBlock: 1000,
            revision: 1,
        });
        expect(restarted.storage.getBlockHash(1, F.Orphan)).toBeNull();
        expect(restarted.checks.hasPending(1, now)).toBe(false);
        expect(selectBalanceOwners(1, s.f.collectionId, "1")).toEqual([
            { owner: F.Owner, amount: "1" },
        ]);
    });

    it("retains the fetch-time check even when the commit happens much later", async () => {
        const s = setup();
        const acquired = s.result([105], 105);
        vi.spyOn(s.rpc, "getBlockNumber").mockResolvedValue(1000);
        s.storage.persistSyncResult(acquired);
        expect(s.due()?.blockNumber).toBe(105);
        await s.recovery.checkDue();
        expect(s.due()).toBeNull();
    });

    it("saves pending checks, facts, coverage and required follow-ups in one transaction", () => {
        const s = setup();
        const result = s.result([105], 105);
        const followUps = buildSyncFollowUps(
            1,
            result.collections,
            { fromBlock: 105, toBlock: 105 },
            [
                {
                    sourceJobId: "atomic-recent",
                    fanoutId: "atomic-recent",
                    sourceKind: "fixture",
                },
            ],
            "realtime",
            result.data,
            BACKFILL_ORDER_MAINTENANCE_POLICY.CurrentState,
        );
        db.exec(
            `CREATE TEMP TRIGGER fail_recent_followup BEFORE INSERT ON queue_outbox WHEN NEW.job_kind='${DOMAIN_JOB_KIND.MetadataSync}' BEGIN SELECT RAISE(ABORT,'followup unavailable'); END;`,
        );
        expect(() =>
            s.commit.commitSyncRange({
                result,
                followUps,
                completion: { kind: SYNC_WORK_COMPLETION.Unmanaged },
            }),
        ).toThrow("followup unavailable");
        expect(s.storage.getBlockHash(1, 105)).toBeNull();
        expect(s.due()).toBeNull();
        expect(
            s.storage.countCollectionSyncedBlocksInRange(
                1,
                s.f.collectionId,
                105,
                105,
            ),
        ).toBe(0);
        db.exec("DROP TRIGGER fail_recent_followup;");
        s.commit.commitSyncRange({
            result,
            followUps,
            completion: { kind: SYNC_WORK_COMPLETION.Unmanaged },
        });
        expect(s.due()?.blockNumber).toBe(105);
        expect(
            (
                db
                    .prepare("SELECT COUNT(*) AS count FROM queue_outbox")
                    .get() as { count: number }
            ).count,
        ).toBeGreaterThan(0);
    });

    it("keeps RPC errors pending with durable backoff, without preventing another eligible check", async () => {
        const s = setup();
        s.storage.persistSyncResult(s.result([104, 105], 105));
        vi.spyOn(s.rpc, "getBlock").mockRejectedValueOnce(
            new Error("RPC unavailable"),
        );
        expect(await s.recovery.checkDue()).toBe(true);
        expect(s.due()?.blockNumber).toBe(105);
        expect(await s.recovery.checkDue()).toBe(true);
        expect(s.due()).toBeNull();
        setDbPath(dbPath);
        now += 100;
        expect(s.due()?.blockNumber).toBe(104);
        expect(await s.recovery.checkDue()).toBe(true);
        expect(s.checks.hasPending(1, now)).toBe(false);
    });

    it("never rearms a verified block or drops an unfinished check during duplicate imports", () => {
        const s = setup();
        s.storage.persistSyncResult(s.result([105], 105));
        s.storage.persistSyncResult(s.result([105], 1000));
        expect(s.due()).not.toBeNull();
        expect(s.checks.complete(s.due()!)).toBe(true);
        s.storage.persistSyncResult(s.result([105], 105));
        expect(s.due()).toBeNull();
    });

    it("makes matching verification conditional on the stored hash and chain revision", () => {
        const s = setup();
        s.storage.persistSyncResult(s.result([105], 105));
        const check = s.due()!;
        expect(s.checks.complete({ ...check, blockHash: "wrong-hash" })).toBe(
            false,
        );
        const wrongChain = {
            ...check,
            checkpoint: { ...check.checkpoint, chainId: 2 },
        };
        expect(() => s.checks.complete(wrongChain)).toThrow(ChainSyncConflict);
        expect(() => s.checks.defer(wrongChain, now + 100)).toThrow(
            ChainSyncConflict,
        );
        db.writeTransaction(() => advanceChainSyncRevision(1))();
        expect(() => s.checks.complete(check)).toThrow(ChainSyncConflict);
        expect(s.due()).not.toBeNull();
    });

    it("cannot consume a mismatch before recovery retention commits", () => {
        const s = setup();
        s.storage.persistSyncResult(s.result([105], 105));
        const check = s.due()!;
        db.exec(
            "CREATE TEMP TRIGGER fail_check_completion BEFORE UPDATE OF canonical_check_pending ON blocks WHEN NEW.canonical_check_pending=0 BEGIN SELECT RAISE(ABORT,'check writer unavailable'); END;",
        );
        expect(() =>
            s.recoveries.retainMismatch({
                checkpoint: check.checkpoint,
                checkedBlock: check.blockNumber,
                storedHash: check.blockHash,
                observedHash: "replacement",
                recoveryId: "atomic-mismatch",
                now,
            }),
        ).toThrow("check writer unavailable");
        expect(s.recoveries.getRecovery(1)).toBeNull();
        expect(s.due()).not.toBeNull();
        db.exec("DROP TRIGGER fail_check_completion;");
        s.recoveries.retainMismatch({
            checkpoint: check.checkpoint,
            checkedBlock: check.blockNumber,
            storedHash: check.blockHash,
            observedHash: "replacement",
            recoveryId: "atomic-mismatch",
            now,
        });
        expect(s.recoveries.getRecovery(1)?.recoveryId).toBe("atomic-mismatch");
        expect(s.due()).toBeNull();
    });

    it("does not schedule delayed RPC checks for finalized imported history", () => {
        const s = setup();
        s.storage.persistSyncResult(s.result([101, 102, 103, 104], 200));
        expect(s.checks.hasPending(1, now)).toBe(false);
    });

    it("keeps young chains below their maturity boundary and requires explicit policy", () => {
        const s = setup();
        expect(canonicalCheckUpperBound(5, 32)).toBe(0);
        s.storage.persistSyncResult(s.result([101], 1, 32));
        expect(s.due(0)).toBeNull();
        expect(() =>
            s.storage.persistSyncResult({
                ...s.result([102], 102),
                canonicalCheck: undefined!,
            }),
        ).toThrow("Invalid canonical check policy");
    });

    it("drains due checks promptly, polls while idle and waits for a running check during shutdown", async () => {
        vi.useFakeTimers();
        try {
            const gate = Promise.withResolvers<boolean>();
            const checkDue = vi
                .fn()
                .mockResolvedValueOnce(true)
                .mockImplementationOnce(() => gate.promise)
                .mockResolvedValue(false);
            const stop = startReorgRecoveryLoop(
                { checkDue, resumeDue: vi.fn(async () => {}) },
                12_000,
            );
            await vi.advanceTimersByTimeAsync(1);
            expect(checkDue).toHaveBeenCalledTimes(2);
            let stopped = false;
            const stopping = stop().then(() => {
                stopped = true;
            });
            await Promise.resolve();
            expect(stopped).toBe(false);
            gate.resolve(true);
            await stopping;
            expect(vi.getTimerCount()).toBe(0);
        } finally {
            vi.useRealTimers();
        }
    });
});
