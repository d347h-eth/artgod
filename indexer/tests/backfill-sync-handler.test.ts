import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { db, setDbPath } from "@artgod/shared/database";
import { createMigrationRunner } from "@artgod/shared/migrations";
import { logger } from "@artgod/shared/utils";
import { createBackfillSyncHandler } from "../src/application/backfill-sync-handler.js";
import { ChainSyncConflict } from "../src/domain/chain-sync.js";
import {
    BACKFILL_ORDER_MAINTENANCE_POLICY as POLICY,
    BACKFILL_SOURCE,
    SYNC_JOB_KIND,
    type BackfillSyncPayload,
} from "../src/domain/sync-jobs.js";
import { QUEUE_NAMES } from "../src/domain/queues.js";
import type { JobEnvelope } from "../src/domain/jobs.js";
import {
    COORDINATED_SYNC_FIXTURE as F,
    createCoordinatorFixture,
} from "./helpers/coordinated-sync-fixture.js";
import { createTempDbPath } from "./helpers/test-helpers.js";
import { loadTestEnv } from "./helpers/test-env.js";

describe("backfill ingress under coordinated authority", () => {
    loadTestEnv();
    beforeEach(async () => {
        setDbPath(await createTempDbPath());
        await createMigrationRunner().runMigrations();
        vi.spyOn(logger, "info").mockImplementation(() => {});
        vi.spyOn(logger, "warn").mockImplementation(() => {});
    });
    afterEach(() => vi.restoreAllMocks());

    function fixture() {
        const s = createCoordinatorFixture();
        const wake = vi.fn();
        const handler = createBackfillSyncHandler({
            chainId: F.chainId,
            workerCount: 2,
            wethAddress: F.weth,
            rpc: s.historical.rpc,
            reorgDepth: F.reorgDepth,
            storage: s.storage,
            commit: s.commit,
            canonicalChecks: s.checks,
            collectionsPort: s.registry,
            extensions: { getInstall: () => null },
            wakeCurrentSync: wake,
            gate: s.gate,
        });
        return { ...s, handler, wake };
    }

    function job(
        payload: BackfillSyncPayload,
        collectionId?: number,
    ): JobEnvelope<BackfillSyncPayload> {
        return {
            jobId: "backfill-test",
            chainId: F.chainId,
            kind: SYNC_JOB_KIND.BackfillRange,
            queue: QUEUE_NAMES.BackfillSync,
            scheduledAt: 0,
            attempt: 0,
            collectionId,
            payload,
        };
    }

    it("treats a skipped-height bootstrap hint as a wakeup without applying or acquiring it", async () => {
        const s = fixture();
        s.sample(902);
        const hint = job(
            {
                source: BACKFILL_SOURCE.BootstrapCatchup,
                fromBlock: 902,
                toBlock: 902,
                orderMaintenancePolicy: POLICY.CurrentState,
            },
            s.collections[0]!.id,
        );
        await s.handler(hint);
        expect(s.wake).toHaveBeenCalledTimes(1);
        expect(s.historical.state.blockReads).toEqual([]);
        expect(s.historical.state.logReads).toEqual([]);
        expect(s.progress.chainProgress(F.chainId)?.applied.number).toBe(900);
        expect(s.storage.getBlockHash(F.chainId, 902)).toBeNull();
        await s.executor.runDue();
        expect(s.progress.chainProgress(F.chainId)?.applied.number).toBe(901);
        await s.handler(hint);
        expect(s.progress.chainProgress(F.chainId)?.applied.number).toBe(901);
    });

    it.each([
        BACKFILL_SOURCE.GapRepair,
        BACKFILL_SOURCE.ReorgRecovery,
    ] as const)(
        "acknowledges %s envelopes without competing with their durable owner",
        async (source) => {
            const s = fixture();
            const payload: BackfillSyncPayload =
                source === BACKFILL_SOURCE.GapRepair
                    ? {
                          source,
                          fromBlock: 901,
                          toBlock: 902,
                          orderMaintenancePolicy: POLICY.CurrentState,
                      }
                    : {
                          source,
                          fromBlock: 901,
                          toBlock: 902,
                          orderMaintenancePolicy: POLICY.CurrentState,
                          recovery: {
                              recoveryId: "retained-owner",
                              revision: 0,
                          },
                      };
            await s.handler(
                job(
                    payload,
                    source === BACKFILL_SOURCE.GapRepair
                        ? s.collections[0]!.id
                        : undefined,
                ),
            );
            expect(s.historical.state.blockReads).toEqual([]);
            expect(s.historical.state.logReads).toEqual([]);
            expect(s.wake).not.toHaveBeenCalled();
            expect(s.progress.chainProgress(F.chainId)?.applied.number).toBe(
                900,
            );
        },
    );

    it("imports manual historical facts at an accepted block without advancing current state", async () => {
        const s = fixture();
        const before = s.progress.validationCheckpoint(
            F.chainId,
            s.collections[0]!.id,
        );
        await s.handler(
            job(
                {
                    source: BACKFILL_SOURCE.ManualHistorical,
                    fromBlock: 900,
                    toBlock: 900,
                    orderMaintenancePolicy: POLICY.SkipGlobalMakerRevalidation,
                },
                s.collections[0]!.id,
            ),
        );
        expect(
            s.storage.countCollectionSyncedBlocksInRange(
                F.chainId,
                s.collections[0]!.id,
                900,
                900,
            ),
        ).toBe(1);
        expect(
            s.progress.validationCheckpoint(F.chainId, s.collections[0]!.id),
        ).toEqual(before);
        expect(s.wake).not.toHaveBeenCalled();
        expect(s.historical.state.logReads.length).toBeGreaterThan(0);
    });

    it("refuses a manual range ahead of shared authority atomically", async () => {
        const s = fixture();
        await expect(
            s.handler(
                job(
                    {
                        source: BACKFILL_SOURCE.ManualHistorical,
                        fromBlock: 902,
                        toBlock: 902,
                        orderMaintenancePolicy:
                            POLICY.SkipGlobalMakerRevalidation,
                    },
                    s.collections[0]!.id,
                ),
            ),
        ).rejects.toThrow(ChainSyncConflict);
        expect(s.storage.getBlockHash(F.chainId, 902)).toBeNull();
        expect(
            s.storage.countCollectionSyncedBlocksInRange(
                F.chainId,
                s.collections[0]!.id,
                902,
                902,
            ),
        ).toBe(0);
        expect(s.progress.chainProgress(F.chainId)?.applied.number).toBe(900);
        expect(
            db.prepare("SELECT COUNT(*) AS count FROM queue_outbox").get(),
        ).toEqual({ count: 0 });
    });

    it("rejects malformed or other-chain hints before wakeup and acquisition", async () => {
        const s = fixture();
        const hint = job(
            {
                source: BACKFILL_SOURCE.BootstrapCatchup,
                fromBlock: 901,
                toBlock: 902,
                orderMaintenancePolicy: POLICY.CurrentState,
            },
            s.collections[0]!.id,
        );
        await s.handler({ ...hint, chainId: 10 });
        await s.handler({
            ...hint,
            payload: { ...hint.payload, toBlock: 899 },
        });
        expect(s.wake).not.toHaveBeenCalled();
        expect(s.historical.state.logReads).toEqual([]);
    });
});
