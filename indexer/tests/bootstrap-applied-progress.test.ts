import { beforeEach, describe, expect, it } from "vitest";
import { db, setDbPath } from "@artgod/shared/database";
import { createMigrationRunner } from "@artgod/shared/migrations";
import { COLLECTION_STATUS } from "@artgod/shared/types";
import { OPENSEA_INTEGRATION_MODE } from "@artgod/shared/config/opensea-integration";
import {
    BOOTSTRAP_BACKFILL_EXECUTOR_OUTCOME,
    BootstrapBackfillExecutor,
} from "../src/application/bootstrap-backfill-executor.js";
import { bootstrapAppliedCheckpoint } from "../src/application/bootstrap-applied-progress.js";
import { ChainSyncConflict } from "../src/domain/chain-sync.js";
import { SqliteChainProgress } from "../src/infra/storage/sqlite-chain-progress.js";
import {
    advanceChainSyncRevision,
    captureChainSyncCheckpoint,
} from "../src/infra/storage/sqlite-chain-revisions.js";
import { createAppliedSyncFixture } from "./helpers/applied-sync-fixture.js";
import {
    insertCollection,
    loadCollection,
} from "./helpers/ownership-fixture.js";
import { syncBlockFixture as block } from "./helpers/chain-fixture.js";
import { createTempDbPath } from "./helpers/test-helpers.js";
import { loadTestEnv } from "./helpers/test-env.js";

const CHAIN_ID = 1;
const ANCHOR = 900;
const ADDRESS = "0x0000000000000000000000000000000000000001";

describe("bootstrap completion uses applied progress", () => {
    loadTestEnv();
    beforeEach(async () => {
        setDbPath(await createTempDbPath());
        await createMigrationRunner().runMigrations();
    });

    function collection() {
        const collectionId = insertCollection({
            chainId: CHAIN_ID,
            slug: "bootstrap-applied",
            address: ADDRESS,
            anchorBlock: ANCHOR,
        });
        db.prepare("UPDATE collections SET status=? WHERE collection_id=?").run(
            COLLECTION_STATUS.Bootstrapping,
            collectionId,
        );
        return collectionId;
    }

    function input(collectionId: number) {
        return {
            chainId: CHAIN_ID,
            collectionId,
            runId: 1,
            address: ADDRESS,
            anchorBlock: ANCHOR,
            anchorHash: block(ANCHOR).hash,
            fromBlock: ANCHOR + 1,
            toBlock: ANCHOR + 5,
            traceId: "bootstrap-applied",
            sourceJobId: "bootstrap-check",
            openSeaIntegration: {
                enabled: false,
                mode: OPENSEA_INTEGRATION_MODE.Disabled,
                reason: "disabled in test",
                missingKeys: [],
                requiredKeys: [],
            },
        };
    }

    function executor(progress: SqliteChainProgress) {
        return new BootstrapBackfillExecutor(
            { getBlockNumber: async () => ANCHOR },
            progress,
            { getCollection: () => null, markOpenSeaPending: () => true },
            { updateRunStatus: () => {}, appendRunEvent: () => {} },
            {
                getStep: () => null,
                markStepRunning: () => {},
                markStepSucceeded: () => {},
                markStepSkipped: () => {},
                updateStepProgress: () => {},
                updateStepResult: () => {},
            },
            {
                scheduleBackfillRange: async () => {},
                scheduleBackfillCheck: async () => {},
                scheduleOpenSeaBootstrap: async () => {},
            },
        );
    }

    function fixture() {
        const collectionId = collection();
        const work = createAppliedSyncFixture({
            chainId: CHAIN_ID,
            anchor: block(ANCHOR),
            collections: [loadCollection(CHAIN_ID, collectionId)],
        });
        const blocks = Array.from({ length: 5 }, (_, index) =>
            block(ANCHOR + index + 1),
        );
        return { ...work, collectionId, blocks };
    }

    it("does not complete from full raw coverage; completes once collection effects reach the retained target", async () => {
        const f = fixture();
        f.commit(
            f.applied({ blocks: f.blocks, shared: true, collectionIds: [] }),
        );
        f.commit(
            f.historical({ blocks: f.blocks, collectionIds: [f.collectionId] }),
        );
        expect(
            f.storage.countCollectionSyncedBlocksInRange(
                CHAIN_ID,
                f.collectionId,
                901,
                905,
            ),
        ).toBe(5);
        const check = executor(f.progress);
        expect(await check.checkProgress(input(f.collectionId))).toMatchObject({
            outcome: BOOTSTRAP_BACKFILL_EXECUTOR_OUTCOME.BackfillIncomplete,
            synced: 0,
        });

        f.commit(
            f.applied({
                blocks: f.blocks,
                shared: false,
                collectionIds: [f.collectionId],
            }),
        );
        expect(await check.checkProgress(input(f.collectionId))).toMatchObject({
            outcome: BOOTSTRAP_BACKFILL_EXECUTOR_OUTCOME.BackfillCompleted,
            synced: 5,
        });
    });

    it("requires coordinator acceptance even when the installed base has no post-anchor work", async () => {
        const collectionId = collection();
        const progress = new SqliteChainProgress();
        const checkpoint = captureChainSyncCheckpoint(CHAIN_ID);
        progress.initializeChain(checkpoint, block(ANCHOR));
        const check = executor(progress);
        expect(
            (await check.scheduleAfterSnapshot(input(collectionId))).outcome,
        ).toBe(BOOTSTRAP_BACKFILL_EXECUTOR_OUTCOME.BackfillQueued);
        db.prepare(
            "INSERT INTO collection_ownership_bases(chain_id,collection_id,run_id,revision,anchor_block,anchor_hash) VALUES (?,?,?,?,?,?)",
        ).run(
            CHAIN_ID,
            collectionId,
            1,
            checkpoint.revision,
            ANCHOR,
            block(ANCHOR).hash,
        );
        expect(
            (await check.scheduleAfterSnapshot(input(collectionId))).outcome,
        ).toBe(BOOTSTRAP_BACKFILL_EXECUTOR_OUTCOME.BackfillQueued);
        progress.acceptCollectionBase(checkpoint, collectionId, block(ANCHOR));
        expect(
            (await check.scheduleAfterSnapshot(input(collectionId))).outcome,
        ).toBe(BOOTSTRAP_BACKFILL_EXECUTOR_OUTCOME.CompletedWithoutBackfill);
    });

    it.each(["revision", "dispute"] as const)(
        "fences final liveness inside the writer after a concurrent %s change",
        (change) => {
            const f = fixture();
            f.commit(
                f.applied({
                    blocks: f.blocks,
                    shared: true,
                    collectionIds: [f.collectionId],
                }),
            );
            const proof = bootstrapAppliedCheckpoint(
                f.progress,
                input(f.collectionId),
            )!;
            if (change === "revision") advanceChainSyncRevision(CHAIN_ID);
            else
                f.progress.retainDispute({
                    checkpoint: proof,
                    chainId: CHAIN_ID,
                    blockNumber: proof.block.number,
                    blockHash: proof.block.hash,
                });
            expect(() =>
                f.registry.markBootstrapFinished(
                    CHAIN_ID,
                    f.collectionId,
                    905,
                    proof,
                ),
            ).toThrow(ChainSyncConflict);
            expect(
                f.registry.getCollection(CHAIN_ID, f.collectionId)?.status,
            ).toBe(COLLECTION_STATUS.Bootstrapping);
        },
    );

    it("makes the collection live only at a still-usable applied checkpoint", () => {
        const f = fixture();
        f.commit(
            f.applied({
                blocks: f.blocks,
                shared: true,
                collectionIds: [f.collectionId],
            }),
        );
        const proof = bootstrapAppliedCheckpoint(
            f.progress,
            input(f.collectionId),
        )!;
        expect(
            f.registry.markBootstrapFinished(
                CHAIN_ID,
                f.collectionId,
                905,
                proof,
            ),
        ).toBe(true);
        expect(f.registry.getCollection(CHAIN_ID, f.collectionId)?.status).toBe(
            COLLECTION_STATUS.Live,
        );
    });
});
