import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createMigrationRunner } from "@artgod/shared/migrations";
import { db, setDbPath } from "@artgod/shared/database";
import {
    BOOTSTRAP_ENUMERATION_MODE,
    BOOTSTRAP_METADATA_MODE,
    BOOTSTRAP_RUN_STATUS,
    BOOTSTRAP_STEP_KEY,
    BOOTSTRAP_STEP_STATUS,
    type BootstrapStepKey,
    serializeBootstrapStepDependencies,
} from "@artgod/shared/bootstrap/pipeline";
import { IMAGE_CACHE_MODE } from "@artgod/shared/media/token-image-cache";
import { COLLECTION_STANDARD } from "../src/domain/collections.js";
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
        db.exec("DELETE FROM bootstrap_runs;");
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

    it("lists run steps with parsed dependencies and marks pending steps ready", () => {
        seedStep(92, BOOTSTRAP_STEP_KEY.Anchor);
        seedStep(92, BOOTSTRAP_STEP_KEY.Enumeration, [
            BOOTSTRAP_STEP_KEY.Anchor,
        ]);
        seedStep(92, BOOTSTRAP_STEP_KEY.Metadata, [
            BOOTSTRAP_STEP_KEY.Enumeration,
        ]);

        const steps = new SqliteBootstrapSteps();
        const runSteps = steps.listRunSteps(92);

        expect(runSteps.map((step) => step.stepKey)).toEqual([
            BOOTSTRAP_STEP_KEY.Anchor,
            BOOTSTRAP_STEP_KEY.Enumeration,
            BOOTSTRAP_STEP_KEY.Metadata,
        ]);
        expect(
            runSteps.find(
                (step) => step.stepKey === BOOTSTRAP_STEP_KEY.Metadata,
            )?.dependsOn,
        ).toEqual([BOOTSTRAP_STEP_KEY.Enumeration]);

        steps.markStepReady(92, BOOTSTRAP_STEP_KEY.Enumeration);

        expect(
            steps.getStep(92, BOOTSTRAP_STEP_KEY.Enumeration),
        ).toEqual(
            expect.objectContaining({
                status: BOOTSTRAP_STEP_STATUS.Ready,
                dependsOn: [BOOTSTRAP_STEP_KEY.Anchor],
            }),
        );
    });

    it("claims and releases ready steps with a lease", () => {
        seedStep(93, BOOTSTRAP_STEP_KEY.Metadata);
        const steps = new SqliteBootstrapSteps();
        steps.markStepReady(93, BOOTSTRAP_STEP_KEY.Metadata);

        const claimed = steps.claimReadySteps({
            runId: 93,
            stepKeys: [BOOTSTRAP_STEP_KEY.Metadata],
            leaseOwner: "test-lease",
            leaseUntil: 2_000,
            nowMs: 1_000,
            limit: 1,
        });

        expect(claimed).toEqual([
            expect.objectContaining({
                status: BOOTSTRAP_STEP_STATUS.Running,
                leaseOwner: "test-lease",
                leaseUntil: 2_000,
            }),
        ]);

        steps.releaseStepLease({
            runId: 93,
            stepKey: BOOTSTRAP_STEP_KEY.Metadata,
            leaseOwner: "test-lease",
            nextAttemptAt: 3_000,
        });

        expect(steps.getStep(93, BOOTSTRAP_STEP_KEY.Metadata)).toEqual(
            expect.objectContaining({
                status: BOOTSTRAP_STEP_STATUS.Ready,
                nextAttemptAt: 3_000,
                leaseOwner: null,
                leaseUntil: null,
            }),
        );
    });

    it("claims expired running leases but not live leases", () => {
        seedStep(94, BOOTSTRAP_STEP_KEY.Metadata);
        const steps = new SqliteBootstrapSteps();
        steps.markStepReady(94, BOOTSTRAP_STEP_KEY.Metadata);
        steps.claimReadySteps({
            runId: 94,
            stepKeys: [BOOTSTRAP_STEP_KEY.Metadata],
            leaseOwner: "old-lease",
            leaseUntil: 2_000,
            nowMs: 1_000,
            limit: 1,
        });

        expect(
            steps.claimReadySteps({
                runId: 94,
                stepKeys: [BOOTSTRAP_STEP_KEY.Metadata],
                leaseOwner: "new-lease",
                leaseUntil: 4_000,
                nowMs: 1_500,
                limit: 1,
            }),
        ).toEqual([]);

        expect(
            steps.claimReadySteps({
                runId: 94,
                stepKeys: [BOOTSTRAP_STEP_KEY.Metadata],
                leaseOwner: "new-lease",
                leaseUntil: 5_000,
                nowMs: 2_500,
                limit: 1,
            }),
        ).toEqual([
            expect.objectContaining({
                status: BOOTSTRAP_STEP_STATUS.Running,
                leaseOwner: "new-lease",
                leaseUntil: 5_000,
            }),
        ]);
    });

    it("tracks delegated running steps with a durable health-check deadline", () => {
        seedStep(98, BOOTSTRAP_STEP_KEY.OpenSeaSnapshot);
        const steps = new SqliteBootstrapSteps();

        steps.markStepDelegatedRunning({
            runId: 98,
            stepKey: BOOTSTRAP_STEP_KEY.OpenSeaSnapshot,
            healthCheckAt: 5_000,
        });

        expect(
            steps.getStep(98, BOOTSTRAP_STEP_KEY.OpenSeaSnapshot),
        ).toEqual(
            expect.objectContaining({
                status: BOOTSTRAP_STEP_STATUS.Running,
                nextAttemptAt: 5_000,
                leaseOwner: null,
                leaseUntil: 5_000,
            }),
        );
        expect(
            steps.claimReadySteps({
                runId: 98,
                stepKeys: [BOOTSTRAP_STEP_KEY.OpenSeaSnapshot],
                leaseOwner: "delegate-reclaimer",
                leaseUntil: 8_000,
                nowMs: 4_000,
                limit: 1,
            }),
        ).toEqual([]);
        expect(
            steps.claimReadySteps({
                runId: 98,
                stepKeys: [BOOTSTRAP_STEP_KEY.OpenSeaSnapshot],
                leaseOwner: "delegate-reclaimer",
                leaseUntil: 8_000,
                nowMs: 5_000,
                limit: 1,
            }),
        ).toEqual([
            expect.objectContaining({
                status: BOOTSTRAP_STEP_STATUS.Running,
                leaseOwner: "delegate-reclaimer",
                leaseUntil: 8_000,
            }),
        ]);
    });

    it("does not regress terminal steps when delegated work is duplicated", () => {
        seedStep(99, BOOTSTRAP_STEP_KEY.OpenSeaReady);
        const steps = new SqliteBootstrapSteps();
        steps.markStepSucceeded(99, BOOTSTRAP_STEP_KEY.OpenSeaReady);

        steps.markStepDelegatedRunning({
            runId: 99,
            stepKey: BOOTSTRAP_STEP_KEY.OpenSeaReady,
            healthCheckAt: 5_000,
        });

        expect(steps.getStep(99, BOOTSTRAP_STEP_KEY.OpenSeaReady)).toEqual(
            expect.objectContaining({
                status: BOOTSTRAP_STEP_STATUS.Succeeded,
                leaseOwner: null,
                leaseUntil: null,
            }),
        );
    });

    it("lists due lane runs and reports the next durable deadline", () => {
        const dueRunId = seedRun(1, 95);
        const futureRunId = seedRun(1, 96);
        const otherChainRunId = seedRun(2, 97);
        seedStep(dueRunId, BOOTSTRAP_STEP_KEY.Metadata);
        seedStep(futureRunId, BOOTSTRAP_STEP_KEY.Metadata);
        seedStep(otherChainRunId, BOOTSTRAP_STEP_KEY.Metadata);
        const steps = new SqliteBootstrapSteps();
        steps.markStepReady(dueRunId, BOOTSTRAP_STEP_KEY.Metadata);
        steps.markStepReady(futureRunId, BOOTSTRAP_STEP_KEY.Metadata);
        steps.markStepReady(otherChainRunId, BOOTSTRAP_STEP_KEY.Metadata);
        db.prepare(
            "UPDATE bootstrap_run_steps SET next_attempt_at = ? WHERE run_id = ?",
        ).run(1_000, dueRunId);
        db.prepare(
            "UPDATE bootstrap_run_steps SET status = ?, lease_until = ? WHERE run_id = ?",
        ).run(BOOTSTRAP_STEP_STATUS.Running, 1_500, futureRunId);

        expect(
            steps.listDueStepRunIds({
                chainId: 1,
                stepKeys: [BOOTSTRAP_STEP_KEY.Metadata],
                nowMs: 1_200,
                limit: 10,
            }),
        ).toEqual([dueRunId]);
        expect(
            steps.listDueStepRunIds({
                chainId: 1,
                stepKeys: [BOOTSTRAP_STEP_KEY.Metadata],
                nowMs: 1_600,
                limit: 10,
            }),
        ).toEqual([dueRunId, futureRunId]);
        expect(
            steps.listDueStepRunIds({
                chainId: 2,
                stepKeys: [BOOTSTRAP_STEP_KEY.Metadata],
                nowMs: 1_200,
                limit: 10,
            }),
        ).toEqual([otherChainRunId]);
        expect(
            steps.getNextDueStepAt({
                chainId: 1,
                stepKeys: [BOOTSTRAP_STEP_KEY.Metadata],
            }),
        ).toBe(1_000);
    });
});

function seedRun(chainId: number, collectionId: number): number {
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
        BOOTSTRAP_RUN_STATUS.Metadata,
    );
    return Number(result.lastInsertRowid);
}

function seedStep(
    runId: number,
    stepKey: BootstrapStepKey,
    dependsOn: BootstrapStepKey[] = [],
): void {
    db.prepare(
        "INSERT INTO bootstrap_run_steps " +
            "(run_id, step_key, status, blocking, depends_on_json) " +
            "VALUES (?, ?, ?, ?, ?)",
    ).run(
        runId,
        stepKey,
        BOOTSTRAP_STEP_STATUS.Pending,
        1,
        serializeBootstrapStepDependencies(dependsOn),
    );
}
