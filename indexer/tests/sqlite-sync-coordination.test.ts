import { beforeEach, describe, expect, it } from "vitest";
import { db, setDbPath } from "@artgod/shared/database";
import { createMigrationRunner } from "@artgod/shared/migrations";
import { COLLECTION_STATUS } from "@artgod/shared/types";
import { SqliteChainProgress } from "../src/infra/storage/sqlite-chain-progress.js";
import { SqliteSyncCoordination } from "../src/infra/storage/sqlite-sync-coordination.js";
import { SYNC_APPLICATION_KIND } from "../src/domain/sync-work.js";
import {
    COORDINATED_SYNC_FIXTURE as F,
    createCoordinatorFixture,
    installedCoordinatorCollection,
    retainInstalledCoordinatorBase,
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

    it("initializes only from an installed current-revision base, never a selected anchor", () => {
        const progress = new SqliteChainProgress();
        const coordination = new SqliteSyncCoordination(progress);
        installedCoordinatorCollection("only-selected", 899);
        const stale = installedCoordinatorCollection("old-revision", 900);
        retainInstalledCoordinatorBase(stale.id, 900, 1);
        expect(coordination.firstInstalledBase(F.chainId)).toBeNull();
        const second = installedCoordinatorCollection("second-base", 902);
        retainInstalledCoordinatorBase(second.id, 902);
        const first = installedCoordinatorCollection("first-base", 901);
        retainInstalledCoordinatorBase(first.id, 901);
        expect(coordination.firstInstalledBase(F.chainId)).toMatchObject({
            blockNumber: 901,
            blockHash: syncBlockFixture(901).hash,
            checkpoint: { chainId: F.chainId, revision: 0 },
        });
        expect(progress.chainProgress(F.chainId)).toBeNull();
    });

    it("exposes joining bases only inside the shared prefix with matching canonical identity", () => {
        const s = createCoordinatorFixture();
        const joining = installedCoordinatorCollection("joining", 901);
        retainInstalledCoordinatorBase(joining.id, 901);
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
            "UPDATE collection_ownership_bases SET anchor_hash=? WHERE collection_id=?",
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
