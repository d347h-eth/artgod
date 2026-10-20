import { beforeEach, describe, expect, it } from "vitest";
import { db, setDbPath } from "@artgod/shared/database";
import { createMigrationRunner } from "@artgod/shared/migrations";
import { findCommonAncestor } from "../src/application/reorg-fork.js";
import {
    REORG_HISTORY_PROOF,
    type ReorgRestoredAgreement,
} from "../src/domain/reorg-fork.js";
import {
    REORG_RECOVERY_PHASE,
    type AwaitingReorgAncestor,
} from "../src/domain/reorg-recovery.js";
import { ChainSyncConflict } from "../src/domain/chain-sync.js";
import {
    createCoordinatorFixture,
    installedCoordinatorCollection,
    retainInstalledCoordinatorBase,
    COORDINATED_SYNC_FIXTURE as F,
} from "./helpers/coordinated-sync-fixture.js";
import { syncBlockFixture as block } from "./helpers/chain-fixture.js";
import { retainCanonicalCheckFixture } from "./helpers/reorg-recovery-fixture.js";
import { createTempDbPath } from "./helpers/test-helpers.js";
import { loadTestEnv } from "./helpers/test-env.js";

describe("restored canonical agreement", () => {
    loadTestEnv();
    let now: number;
    let databasePath: string;
    beforeEach(async () => {
        databasePath = await createTempDbPath();
        setDbPath(databasePath);
        await createMigrationRunner().runMigrations();
        now = 1_000;
    });

    type Fixture = ReturnType<typeof createCoordinatorFixture>;

    async function drain(f: Pick<Fixture, "executor">) {
        for (let pass = 0; pass < 30; pass++)
            if (!(await f.executor.runDue())) return;
        throw new Error("Coordinator did not settle its bounded work");
    }

    function mismatch(f: Fixture, number: number, recoveryId: string) {
        const check = retainCanonicalCheckFixture(f.storage, number);
        return f.recoveries.retainMismatch({
            checkpoint: check.checkpoint,
            recoveryId,
            checkedBlock: number,
            storedHash: check.blockHash,
            observedHash: block(number + 10_000).hash,
            now,
        });
    }

    function disputedChecks() {
        return db
            .prepare(
                "SELECT block_number AS number,canonical_check_pending AS pending FROM blocks WHERE chain_id=? AND canonical_check_disputed=1 ORDER BY block_number",
            )
            .all(F.chainId);
    }

    async function agreement(f: Fixture, number: number) {
        const proof = await findCommonAncestor({
            rpc: f.remote.rpc,
            storage: f.storage,
            chainId: F.chainId,
            startBlock: number,
            reorgDepth: F.reorgDepth,
        });
        expect(proof?.kind).toBe(REORG_HISTORY_PROOF.RestoredAgreement);
        return proof as ReorgRestoredAgreement;
    }

    it("continues after one bad anchor reply without rolling back accepted state", async () => {
        const f = createCoordinatorFixture({ now: () => now });
        f.sample(F.head);
        const original = f.remote.rpc.getBlock;
        let badReply = true;
        f.remote.rpc.getBlock = async (number, options) => {
            if (number === F.anchor && badReply) {
                badReply = false;
                return { ...block(number), hash: block(10_900).hash };
            }
            return original(number, options);
        };

        await drain(f);

        expect(f.progress.chainProgress(F.chainId)?.applied.number).toBe(
            F.head,
        );
        expect(
            f.progress.validationCheckpoint(F.chainId, f.collections[0].id)
                ?.block.number,
        ).toBe(F.head);
        expect(f.storage.captureSyncCheckpoint(F.chainId).revision).toBe(0);
        expect(f.recoveries.getRecovery(F.chainId)).toBeNull();
        expect(disputedChecks()).toEqual([]);
    });

    it("survives failed proof and restart, and preserves a newer installed collection base", async () => {
        const f = createCoordinatorFixture({ now: () => now });
        f.sample(F.head);
        await drain(f);
        const joining = installedCoordinatorCollection("newer-base", 903);
        retainInstalledCoordinatorBase(joining.id, 903);
        const original = f.remote.rpc.getBlock;
        mismatch(f, F.anchor, "restored-after-restart");
        f.remote.rpc.getBlock = async () => {
            throw new Error("Temporary header outage");
        };
        await f.recovery.resumeDue();
        expect(f.recoveries.getRecovery(F.chainId)?.phase).toBe(
            REORG_RECOVERY_PHASE.AwaitingAncestor,
        );
        expect(
            f.progress.validationCheckpoint(F.chainId, f.collections[0].id),
        ).toBeNull();

        db.raw.close();
        setDbPath(databasePath);
        f.remote.rpc.getBlock = original;
        now += F.retryDelayMs;
        const restarted = f.restart();
        await drain(restarted);

        expect(restarted.recoveries.getRecovery(F.chainId)).toBeNull();
        expect(
            restarted.progress.validationCheckpoint(
                F.chainId,
                f.collections[0].id,
            )?.block.number,
        ).toBe(F.head);
        expect(
            restarted.storage.captureSyncCheckpoint(F.chainId).revision,
        ).toBe(0);
        expect(
            db
                .prepare(
                    "SELECT anchor_block FROM collection_ownership_bases WHERE chain_id=? AND collection_id=?",
                )
                .get(F.chainId, joining.id),
        ).toEqual({ anchor_block: 903 });
    });

    it("keeps an actually replaced accepted base gated", async () => {
        const f = createCoordinatorFixture({ now: () => now });
        f.sample(F.head);
        f.remote.state.headers.set(F.anchor, {
            ...block(F.anchor),
            hash: block(10_900).hash,
        });
        for (let retry = 0; retry < 3; retry++) {
            await drain(f);
            now += F.retryDelayMs;
        }
        expect(f.recoveries.getRecovery(F.chainId)?.phase).toBe(
            REORG_RECOVERY_PHASE.AwaitingAncestor,
        );
        expect(f.progress.chainProgress(F.chainId)?.applied.number).toBe(
            F.anchor,
        );
        expect(
            f.progress.validationCheckpoint(F.chainId, f.collections[0].id),
        ).toBeNull();
        expect(f.storage.captureSyncCheckpoint(F.chainId).revision).toBe(0);
    });

    it("does not lose a later genuine mismatch coalesced behind restored agreement", async () => {
        const f = createCoordinatorFixture({ now: () => now });
        f.sample(F.head);
        await drain(f);
        const first = mismatch(f, F.anchor, "earlier-transient");
        const coalesced = mismatch(f, F.head, "later-real");
        expect(coalesced.recoveryId).toBe(first.recoveryId);
        f.remote.state.headers.set(F.head, {
            ...block(F.head),
            hash: block(F.head + 10_000).hash,
        });

        await f.recovery.resumeDue();
        expect(f.recoveries.getRecovery(F.chainId)).toBeNull();
        expect(disputedChecks()).toEqual([
            { number: F.anchor, pending: 1 },
            { number: F.head, pending: 1 },
        ]);
        expect(
            f.progress.validationCheckpoint(F.chainId, f.collections[0].id),
        ).toBeNull();
        await drain(f);

        expect(f.storage.captureSyncCheckpoint(F.chainId).revision).toBe(1);
        expect(f.storage.getBlockHash(F.chainId, F.head)).toBe(
            block(F.head + 10_000).hash,
        );
        expect(
            f.progress.validationCheckpoint(F.chainId, f.collections[0].id)
                ?.block.hash,
        ).toBe(block(F.head + 10_000).hash);
        expect(f.recoveries.getRecovery(F.chainId)).toBeNull();
        expect(disputedChecks()).toEqual([]);
    });

    it("returns a concurrent same-block dispute to its own fresh check", async () => {
        const f = createCoordinatorFixture({ now: () => now });
        const expected = mismatch(f, F.anchor, "first-disagreement");
        const proof = await agreement(f, F.anchor);
        const check = {
            chainId: F.chainId,
            checkpoint: f.storage.captureSyncCheckpoint(F.chainId),
            blockNumber: F.anchor,
            blockHash: block(F.anchor).hash,
        };
        f.checks.retain(check, { disputed: true });
        f.recoveries.commitRestoredAgreement({ expected, proof, next: null });
        expect(disputedChecks()).toEqual([{ number: F.anchor, pending: 1 }]);
        // A pre-conflict matching response cannot consume the new generation.
        expect(
            f.checks.confirmCanonicalBlock({ ...check, generation: 1 }),
        ).toBe(false);
        expect(
            f.progress.validationCheckpoint(F.chainId, f.collections[0].id),
        ).toBeNull();
        await f.recovery.checkDue();
        expect(disputedChecks()).toEqual([]);
    });

    it.each(["identity", "version", "revision"] as const)(
        "fences restored-agreement settlement against a changed %s",
        async (change) => {
            const f = createCoordinatorFixture({ now: () => now });
            const expected = mismatch(f, F.anchor, "captured-recovery");
            const proof = await agreement(f, F.anchor);
            // Exercise transaction guards with stale caller inputs; the real
            // retained journal and local lineage are not modified by the test.
            const stale: AwaitingReorgAncestor = {
                ...expected,
                ...(change === "identity"
                    ? { recoveryId: "stale-recovery" }
                    : change === "version"
                      ? { version: expected.version + 1 }
                      : { revision: expected.revision + 1 }),
            };
            expect(() =>
                f.recoveries.commitRestoredAgreement({
                    expected: stale,
                    proof,
                    next: null,
                }),
            ).toThrow(ChainSyncConflict);
            expect(f.recoveries.getRecovery(F.chainId)).toEqual(expected);
            expect(disputedChecks()).toEqual([
                { number: F.anchor, pending: 0 },
            ]);
        },
    );

    it("rolls back rearmed checks if restored-agreement journal settlement fails", async () => {
        const f = createCoordinatorFixture({ now: () => now });
        const expected = mismatch(f, F.anchor, "atomic-restoration");
        const proof = await agreement(f, F.anchor);
        db.exec(
            "CREATE TEMP TRIGGER reject_restoration BEFORE DELETE ON chain_reorg_recoveries BEGIN SELECT RAISE(ABORT,'journal unavailable'); END;",
        );
        expect(() =>
            f.recoveries.commitRestoredAgreement({
                expected,
                proof,
                next: null,
            }),
        ).toThrow("journal unavailable");
        expect(f.recoveries.getRecovery(F.chainId)).toEqual(expected);
        expect(disputedChecks()).toEqual([{ number: F.anchor, pending: 0 }]);
        db.exec("DROP TRIGGER reject_restoration");
        await drain(f);
        expect(f.recoveries.getRecovery(F.chainId)).toBeNull();
    });

    it("resumes an interrupted canonical acquisition without another rollback", async () => {
        const f = createCoordinatorFixture({ now: () => now });
        f.sample(F.head);
        await drain(f);
        for (let number = 903; number <= F.head; number++)
            f.remote.state.headers.set(number, {
                ...block(number),
                hash: block(number + 10_000).hash,
                parentHash:
                    number === 903
                        ? block(902).hash
                        : block(number + 9_999).hash,
            });
        mismatch(f, F.head, "real-fork");
        await f.recovery.resumeDue();
        expect(f.recoveries.getRecovery(F.chainId)).toMatchObject({
            phase: REORG_RECOVERY_PHASE.Resync,
            fromBlock: 903,
            revision: 1,
        });
        mismatch(f, 902, "transient-during-resync");
        expect(f.recoveries.getRecovery(F.chainId)).toMatchObject({
            phase: REORG_RECOVERY_PHASE.AwaitingAncestor,
            resumeFrom: 903,
        });

        await f.recovery.resumeDue();
        expect(f.recoveries.getRecovery(F.chainId)).toMatchObject({
            phase: REORG_RECOVERY_PHASE.Resync,
            fromBlock: 903,
            revision: 1,
        });
        expect(f.storage.captureSyncCheckpoint(F.chainId).revision).toBe(1);
        db.raw.close();
        setDbPath(databasePath);
        const restarted = f.restart();
        await drain(restarted);
        expect(restarted.recoveries.getRecovery(F.chainId)).toBeNull();
        expect(
            restarted.storage.captureSyncCheckpoint(F.chainId).revision,
        ).toBe(1);
        expect(
            restarted.progress.validationCheckpoint(
                F.chainId,
                f.collections[0].id,
            )?.block.hash,
        ).toBe(block(F.head + 10_000).hash);
    });
});
