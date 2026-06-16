import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createMigrationRunner } from "@artgod/shared/migrations";
import { db, setDbPath } from "@artgod/shared/database";
import {
    BOOTSTRAP_ENUMERATION_MODE,
    BOOTSTRAP_METADATA_MODE,
    BOOTSTRAP_RUN_STATUS,
    BOOTSTRAP_STEP_KEY,
    BOOTSTRAP_STEP_STATUS,
    serializeBootstrapStepDependencies,
    type BootstrapRunStatus,
    type BootstrapStepKey,
} from "@artgod/shared/bootstrap/pipeline";
import { IMAGE_CACHE_MODE } from "@artgod/shared/media/token-image-cache";
import { COLLECTION_STANDARD } from "../src/domain/collections.js";
import { SqliteBootstrapRuns } from "../src/infra/bootstrap/sqlite-runs.js";
import { createTempDbPath } from "./helpers/test-helpers.js";
import { loadTestEnv } from "./helpers/test-env.js";

describe("bootstrap runs storage", () => {
    loadTestEnv();

    beforeAll(async () => {
        const dbPath = await createTempDbPath();
        setDbPath(dbPath);
        const migrations = createMigrationRunner();
        await migrations.runMigrations();
    });

    beforeEach(() => {
        db.exec("DELETE FROM bootstrap_runs;");
    });

    it("lists active runs and completed runs with recoverable side-lane steps", () => {
        seedRun(1, 101, BOOTSTRAP_RUN_STATUS.Queued);
        seedRun(1, 102, BOOTSTRAP_RUN_STATUS.Metadata);
        seedRun(1, 103, BOOTSTRAP_RUN_STATUS.Completed);
        seedRun(1, 104, BOOTSTRAP_RUN_STATUS.Failed);
        const completedWithSideLaneRunId = seedRun(
            1,
            105,
            BOOTSTRAP_RUN_STATUS.Completed,
        );
        seedSideLaneStep(
            completedWithSideLaneRunId,
            BOOTSTRAP_STEP_KEY.ImageCache,
        );
        const completedWithOpenSeaSideLaneRunId = seedRun(
            1,
            106,
            BOOTSTRAP_RUN_STATUS.Completed,
        );
        seedSideLaneStep(
            completedWithOpenSeaSideLaneRunId,
            BOOTSTRAP_STEP_KEY.OpenSeaSnapshot,
        );
        seedRun(2, 201, BOOTSTRAP_RUN_STATUS.Queued);

        const runs = new SqliteBootstrapRuns().listRunsForStartupSweep(1, 10);

        expect(runs.map((run) => run.collectionId)).toEqual([
            101, 102, 105, 106,
        ]);
        expect(runs.map((run) => run.status)).toEqual([
            BOOTSTRAP_RUN_STATUS.Queued,
            BOOTSTRAP_RUN_STATUS.Metadata,
            BOOTSTRAP_RUN_STATUS.Completed,
            BOOTSTRAP_RUN_STATUS.Completed,
        ]);
    });
});

function seedRun(
    chainId: number,
    collectionId: number,
    status: BootstrapRunStatus,
): number {
    const result = db.prepare(
        "INSERT INTO bootstrap_runs " +
            "(chain_id, collection_id, request_slug, request_address, request_standard, metadata_mode, enumeration_mode, request_image_cache_mode, status) " +
            "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
    ).run(
        chainId,
        collectionId,
        `collection-${collectionId}`,
        "0x0000000000000000000000000000000000000001",
        COLLECTION_STANDARD.Erc721,
        BOOTSTRAP_METADATA_MODE.BestEffort,
        BOOTSTRAP_ENUMERATION_MODE.Enumerable,
        IMAGE_CACHE_MODE.Off,
        status,
    );
    return Number(result.lastInsertRowid);
}

function seedSideLaneStep(runId: number, stepKey: BootstrapStepKey): void {
    db.prepare(
        "INSERT INTO bootstrap_run_steps " +
            "(run_id, step_key, status, blocking, depends_on_json) " +
            "VALUES (?, ?, ?, ?, ?)",
    ).run(
        runId,
        stepKey,
        BOOTSTRAP_STEP_STATUS.Ready,
        0,
        serializeBootstrapStepDependencies([]),
    );
}
