import { beforeEach, describe, expect, it } from "vitest";
import { db, setDbPath } from "@artgod/shared/database";
import { createMigrationRunner } from "@artgod/shared/migrations";
import { COLLECTION_STATUS } from "@artgod/shared/types";
import {
    BOOTSTRAP_RUN_STATUS,
    BOOTSTRAP_STEP_KEY,
    BOOTSTRAP_STEP_STATUS,
} from "@artgod/shared/bootstrap/pipeline";
import { SqliteChainProgress } from "../src/infra/storage/sqlite-chain-progress.js";
import { SqliteSyncCoordination } from "../src/infra/storage/sqlite-sync-coordination.js";
import { SYNC_APPLICATION_KIND } from "../src/domain/sync-work.js";
import {
    COORDINATED_SYNC_FIXTURE as F,
    createCoordinatorFixture,
    installedCoordinatorCollection,
    authorizeCoordinatorBootstrapCatchup,
} from "./helpers/coordinated-sync-fixture.js";
import { syncBlockFixture } from "./helpers/chain-fixture.js";
import { createTempDbPath } from "./helpers/test-helpers.js";
import { loadTestEnv } from "./helpers/test-env.js";

describe("SQLite sync coordination selection and retry authority", () => {
    loadTestEnv();
    beforeEach(async () => {
        setDbPath(await createTempDbPath());
        await createMigrationRunner().runMigrations();
    });

    it("does not accept a bootstrap snapshot before its final Backfill handover", () => {
        const s = createCoordinatorFixture();
        const collection = installedCoordinatorCollection(
            "not-yet-backfill",
            900,
        );
        const runId = authorizeCoordinatorBootstrapCatchup(collection.id, 900);
        db.prepare("UPDATE bootstrap_runs SET status=? WHERE run_id=?").run(
            BOOTSTRAP_RUN_STATUS.Ownership,
            runId,
        );
        expect(
            s.coordination.unacceptedCollectionBases(F.chainId, 1000, 64),
        ).toEqual([]);
        expect(() =>
            s.progress.acceptCollectionBase(
                { chainId: F.chainId, revision: 0 },
                collection.id,
                syncBlockFixture(900),
                runId,
            ),
        ).toThrow("Backfill authorization");
        db.prepare("UPDATE bootstrap_runs SET status=? WHERE run_id=?").run(
            BOOTSTRAP_RUN_STATUS.Backfill,
            runId,
        );
        expect(
            s.coordination.unacceptedCollectionBases(F.chainId, 1000, 64),
        ).toMatchObject([{ collectionId: collection.id, runId }]);
    });

    it("exposes joining bases only inside the shared prefix with matching canonical identity", () => {
        const s = createCoordinatorFixture();
        const joining = installedCoordinatorCollection("joining", 901);
        authorizeCoordinatorBootstrapCatchup(joining.id, 901);
        expect(
            s.coordination.unacceptedCollectionBases(F.chainId, 1_000, 64),
        ).toEqual([]);
        s.commitFixture(
            s.applied({
                shared: true,
                collectionIds: [],
                blocks: [syncBlockFixture(901)],
            }),
        );
        expect(
            s.coordination.unacceptedCollectionBases(F.chainId, 1_000, 64),
        ).toEqual([
            {
                collectionId: joining.id,
                runId: expect.any(Number),
                checkpoint: { chainId: F.chainId, revision: 0 },
                anchor: { number: 901, hash: syncBlockFixture(901).hash },
                acceptedHeader: {
                    number: 901,
                    hash: syncBlockFixture(901).hash,
                    parentHash: syncBlockFixture(901).parentHash,
                    timestamp: 901,
                },
            },
        ]);
        db.prepare(
            "UPDATE bootstrap_runs SET anchor_block_hash=? WHERE collection_id=?",
        ).run(syncBlockFixture(999).hash, joining.id);
        expect(
            s.coordination.unacceptedCollectionBases(F.chainId, 1_000, 64),
        ).toEqual([]);
    });

    it("keeps a failed scope behind ready peers and retains scheduling across adapter restart", () => {
        const s = createCoordinatorFixture({ collectionCount: 2 });
        s.commitFixture(
            s.applied({
                shared: true,
                collectionIds: [],
                blocks: [syncBlockFixture(901)],
            }),
        );
        const first = s.coordination.nextCollectionCatchup(F.chainId, 1_000)!;
        s.coordination.recordAttempt(
            {
                kind: SYNC_APPLICATION_KIND.Applied,
                chain: null,
                collections: [first],
            },
            1_000,
            1_100,
        );
        const restarted = new SqliteSyncCoordination(new SqliteChainProgress());
        expect(
            restarted.nextCollectionCatchup(F.chainId, 1_000)?.collectionId,
        ).toBe(s.collections[1]!.id);
        const second = restarted.nextCollectionCatchup(F.chainId, 1_000)!;
        restarted.recordAttempt(
            {
                kind: SYNC_APPLICATION_KIND.Applied,
                chain: null,
                collections: [second],
            },
            1_001,
            1_200,
        );
        expect(restarted.nextCollectionCatchup(F.chainId, 1_099)).toBeNull();
        expect(
            restarted.nextCollectionCatchup(F.chainId, 1_100)?.collectionId,
        ).toBe(first.collectionId);
    });

    it("excludes a terminal Backfill before selecting an unrelated live catch-up", () => {
        const s = createCoordinatorFixture({ collectionCount: 0 });
        const terminal = installedCoordinatorCollection(
            "terminal-backfill",
            F.anchor,
        );
        const runId = authorizeCoordinatorBootstrapCatchup(
            terminal.id,
            F.anchor,
        );
        s.progress.acceptCollectionBase(
            s.storage.captureSyncCheckpoint(F.chainId),
            terminal.id,
            syncBlockFixture(F.anchor),
            runId,
        );
        const live = installedCoordinatorCollection("healthy-live", F.anchor);
        s.progress.acceptCollectionBase(
            s.storage.captureSyncCheckpoint(F.chainId),
            live.id,
            syncBlockFixture(F.anchor),
        );
        s.commitFixture(
            s.applied({
                shared: true,
                collectionIds: [],
                blocks: [syncBlockFixture(F.anchor + 1)],
            }),
        );
        // The orchestrator terminalizes a step without changing its run status.
        db.prepare(
            "UPDATE bootstrap_run_steps SET status=? WHERE run_id=? AND step_key=?",
        ).run(
            BOOTSTRAP_STEP_STATUS.FailedTerminal,
            runId,
            BOOTSTRAP_STEP_KEY.Backfill,
        );
        expect(
            s.coordination.nextCollectionCatchup(F.chainId, 1_000)
                ?.collectionId,
        ).toBe(live.id);
    });

    it("excludes terminal Backfill handoffs before limiting base candidates", () => {
        const s = createCoordinatorFixture({ collectionCount: 0 });
        const terminal = installedCoordinatorCollection(
            "terminal-base",
            F.anchor,
        );
        const terminalRun = authorizeCoordinatorBootstrapCatchup(
            terminal.id,
            F.anchor,
        );
        const ready = installedCoordinatorCollection("ready-base", F.anchor);
        const readyRun = authorizeCoordinatorBootstrapCatchup(
            ready.id,
            F.anchor,
        );
        db.prepare(
            "UPDATE bootstrap_run_steps SET status=? WHERE run_id=? AND step_key=?",
        ).run(
            BOOTSTRAP_STEP_STATUS.FailedTerminal,
            terminalRun,
            BOOTSTRAP_STEP_KEY.Backfill,
        );
        expect(
            s.coordination.unacceptedCollectionBases(F.chainId, 1_000, 1),
        ).toMatchObject([{ collectionId: ready.id, runId: readyRun }]);
    });

    it("keeps coordinator base backoff independent of scheduler health-check timing", () => {
        const s = createCoordinatorFixture({ collectionCount: 0 });
        const joining = installedCoordinatorCollection(
            "delegated-base",
            F.anchor,
        );
        const runId = authorizeCoordinatorBootstrapCatchup(
            joining.id,
            F.anchor,
        );
        db.prepare(
            "UPDATE bootstrap_run_steps SET next_attempt_at=6000 WHERE run_id=? AND step_key=?",
        ).run(runId, BOOTSTRAP_STEP_KEY.Backfill);
        const base = s.coordination.unacceptedCollectionBases(
            F.chainId,
            1_000,
            1,
        )[0]!;
        expect(base.collectionId).toBe(joining.id);
        s.coordination.recordBaseAttempt(base, 1_000, 1_100);
        expect(
            db
                .prepare(
                    "SELECT next_attempt_at FROM bootstrap_run_steps WHERE run_id=? AND step_key=?",
                )
                .get(runId, BOOTSTRAP_STEP_KEY.Backfill),
        ).toEqual({ next_attempt_at: 6000 });
        const resumed = new SqliteSyncCoordination(new SqliteChainProgress());
        expect(resumed.unacceptedCollectionBases(F.chainId, 1_099, 1)).toEqual(
            [],
        );
        expect(
            resumed.unacceptedCollectionBases(F.chainId, 1_100, 1),
        ).toMatchObject([{ collectionId: joining.id, runId }]);
    });

    it("does not let an old range completion replace newer retry scheduling", () => {
        const s = createCoordinatorFixture();
        const old = s.progress.chainProgress(F.chainId)!;
        s.commitFixture(
            s.applied({
                shared: true,
                collectionIds: [],
                blocks: [syncBlockFixture(901)],
            }),
        );
        const current = s.progress.chainProgress(F.chainId)!;
        s.coordination.recordAttempt(
            {
                kind: SYNC_APPLICATION_KIND.Applied,
                chain: current,
                collections: [],
            },
            1_000,
            1_100,
        );
        s.coordination.recordAttempt(
            {
                kind: SYNC_APPLICATION_KIND.Applied,
                chain: old,
                collections: [],
            },
            1_001,
            0,
        );
        expect(s.coordination.sharedDue(F.chainId, 1_099)).toBe(false);
        expect(s.coordination.sharedDue(F.chainId, 1_100)).toBe(true);
    });

    it("excludes paused, reanchored and caught-up collections before selecting work", () => {
        const s = createCoordinatorFixture({ collectionCount: 3 });
        s.commitFixture(
            s.applied({
                shared: true,
                collectionIds: [s.collections[2]!.id],
                blocks: [syncBlockFixture(901)],
            }),
        );
        db.prepare("UPDATE collections SET status=? WHERE collection_id=?").run(
            COLLECTION_STATUS.Paused,
            s.collections[0]!.id,
        );
        db.prepare(
            "UPDATE collections SET bootstrap_anchor_block=901 WHERE collection_id=?",
        ).run(s.collections[1]!.id);
        expect(
            s.coordination.nextCollectionCatchup(F.chainId, 1_000),
        ).toBeNull();
        db.prepare("UPDATE collections SET status=? WHERE collection_id=?").run(
            COLLECTION_STATUS.Live,
            s.collections[0]!.id,
        );
        expect(
            s.coordination.nextCollectionCatchup(F.chainId, 1_000)
                ?.collectionId,
        ).toBe(s.collections[0]!.id);
    });

    it("gates application immediately when a retained canonical identity is disputed", () => {
        const s = createCoordinatorFixture();
        expect(s.coordination.canAdvance(F.chainId)).toBe(true);
        s.checks.retain(
            {
                chainId: F.chainId,
                checkpoint: s.storage.captureSyncCheckpoint(F.chainId),
                blockNumber: F.anchor,
                blockHash: syncBlockFixture(F.anchor).hash,
            },
            { disputed: true },
        );
        expect(s.coordination.canAdvance(F.chainId)).toBe(false);
        expect(
            s.progress.validationCheckpoint(F.chainId, s.collections[0]!.id),
        ).toBeNull();
    });
});
