import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createMigrationRunner } from "@artgod/shared/migrations";
import { db, setDbPath } from "@artgod/shared/database";
import {
    BOOTSTRAP_STEP_KEY,
    BOOTSTRAP_STEP_STATUS,
    serializeBootstrapStepDependencies,
} from "@artgod/shared/bootstrap/pipeline";
import { SqliteBootstrapSteps } from "../src/infra/bootstrap/sqlite-steps.js";
import { createTempDbPath } from "./helpers/test-helpers.js";
import { loadTestEnv } from "./helpers/test-env.js";

describe("bootstrap steps storage", () => {
    loadTestEnv();

    beforeAll(async () => {
        const dbPath = await createTempDbPath();
        setDbPath(dbPath);
        const migrations = createMigrationRunner();
        await migrations.runMigrations();
    });

    beforeEach(() => {
        db.exec("DELETE FROM bootstrap_run_steps;");
    });

    it("tracks running, progress, success, skip, and failure states", () => {
        seedStep(91, BOOTSTRAP_STEP_KEY.Metadata);
        seedStep(91, BOOTSTRAP_STEP_KEY.ImageCache);
        seedStep(91, BOOTSTRAP_STEP_KEY.Backfill);

        const steps = new SqliteBootstrapSteps();
        steps.markStepRunning(91, BOOTSTRAP_STEP_KEY.Metadata);
        steps.updateStepProgress(91, BOOTSTRAP_STEP_KEY.Metadata, {
            completed: 5,
            total: 10,
        });
        expect(
            steps.getStep(91, BOOTSTRAP_STEP_KEY.Metadata),
        ).toEqual(
            expect.objectContaining({
                runId: 91,
                stepKey: BOOTSTRAP_STEP_KEY.Metadata,
                status: BOOTSTRAP_STEP_STATUS.Running,
                progressCompleted: 5,
                progressTotal: 10,
            }),
        );

        steps.markStepSucceeded(91, BOOTSTRAP_STEP_KEY.Metadata, {
            completed: 10,
            total: 10,
        });
        expect(
            steps.getStep(91, BOOTSTRAP_STEP_KEY.Metadata),
        ).toEqual(
            expect.objectContaining({
                status: BOOTSTRAP_STEP_STATUS.Succeeded,
                progressCompleted: 10,
                progressTotal: 10,
                lastError: null,
            }),
        );

        steps.markStepSkipped(
            91,
            BOOTSTRAP_STEP_KEY.ImageCache,
            "no image cache tasks",
        );
        expect(
            steps.getStep(91, BOOTSTRAP_STEP_KEY.ImageCache)?.status,
        ).toBe(BOOTSTRAP_STEP_STATUS.Skipped);

        steps.markStepFailedRetry({
            runId: 91,
            stepKey: BOOTSTRAP_STEP_KEY.Backfill,
            attempts: 1,
            nextAttemptAt: 123,
            error: "coverage incomplete",
        });
        expect(
            steps.getStep(91, BOOTSTRAP_STEP_KEY.Backfill),
        ).toEqual(
            expect.objectContaining({
                status: BOOTSTRAP_STEP_STATUS.FailedRetry,
                attempts: 1,
                lastError: "coverage incomplete",
            }),
        );

        steps.markStepFailedTerminal({
            runId: 91,
            stepKey: BOOTSTRAP_STEP_KEY.Backfill,
            attempts: 2,
            error: "coverage failed",
        });
        expect(
            steps.getStep(91, BOOTSTRAP_STEP_KEY.Backfill),
        ).toEqual(
            expect.objectContaining({
                status: BOOTSTRAP_STEP_STATUS.FailedTerminal,
                attempts: 2,
                lastError: "coverage failed",
            }),
        );
    });
});

function seedStep(runId: number, stepKey: string): void {
    db.prepare(
        "INSERT INTO bootstrap_run_steps " +
            "(run_id, step_key, status, blocking, depends_on_json) " +
            "VALUES (?, ?, ?, ?, ?)",
    ).run(
        runId,
        stepKey,
        BOOTSTRAP_STEP_STATUS.Pending,
        1,
        serializeBootstrapStepDependencies([]),
    );
}
