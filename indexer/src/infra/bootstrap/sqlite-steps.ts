import { db } from "@artgod/shared/database";
import {
    BOOTSTRAP_STEP_STATUS,
    parseBootstrapStepDependencies,
    type BootstrapStepKey,
    type BootstrapStepStatus,
} from "@artgod/shared/bootstrap/pipeline";
import type {
    BootstrapStepProgress,
    BootstrapStepRecord,
    BootstrapStepsPort,
} from "../../ports/bootstrap-steps.js";

type BootstrapStepDbRow = {
    run_id: number;
    step_key: BootstrapStepKey;
    status: BootstrapStepStatus;
    blocking: number;
    depends_on_json: string | null;
    progress_completed: number;
    progress_total: number | null;
    attempts: number;
    last_error: string | null;
};

// SQLite adapter for the durable bootstrap_run_steps orchestration journal.
export class SqliteBootstrapSteps implements BootstrapStepsPort {
    private selectStepStmt = db.prepare<{
        runId: number;
        stepKey: BootstrapStepKey;
    }>(
        "SELECT run_id, step_key, status, blocking, depends_on_json, progress_completed, progress_total, attempts, last_error " +
            "FROM bootstrap_run_steps WHERE run_id = @runId AND step_key = @stepKey LIMIT 1",
    );

    private selectRunStepsStmt = db.prepare<{ runId: number }>(
        "SELECT run_id, step_key, status, blocking, depends_on_json, progress_completed, progress_total, attempts, last_error " +
            "FROM bootstrap_run_steps WHERE run_id = @runId ORDER BY rowid ASC",
    );

    private markReadyStmt = db.prepare<{
        runId: number;
        stepKey: BootstrapStepKey;
        status: BootstrapStepStatus;
        pendingStatus: BootstrapStepStatus;
    }>(
        "UPDATE bootstrap_run_steps SET " +
            "status = @status, next_attempt_at = 0, updated_at = CURRENT_TIMESTAMP " +
            "WHERE run_id = @runId AND step_key = @stepKey AND status = @pendingStatus",
    );

    private markRunningStmt = db.prepare<{
        runId: number;
        stepKey: BootstrapStepKey;
        status: BootstrapStepStatus;
    }>(
        "UPDATE bootstrap_run_steps SET " +
            "status = @status, started_at = COALESCE(started_at, CURRENT_TIMESTAMP), updated_at = CURRENT_TIMESTAMP " +
            "WHERE run_id = @runId AND step_key = @stepKey",
    );

    private markSucceededStmt = db.prepare<{
        runId: number;
        stepKey: BootstrapStepKey;
        status: BootstrapStepStatus;
        completed: number;
        total: number | null;
        resultJson: string | null;
    }>(
        "UPDATE bootstrap_run_steps SET " +
            "status = @status, progress_completed = @completed, progress_total = @total, result_json = @resultJson, " +
            "last_error = NULL, last_error_at = NULL, finished_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP " +
            "WHERE run_id = @runId AND step_key = @stepKey",
    );

    private markSkippedStmt = db.prepare<{
        runId: number;
        stepKey: BootstrapStepKey;
        status: BootstrapStepStatus;
        resultJson: string;
    }>(
        "UPDATE bootstrap_run_steps SET " +
            "status = @status, result_json = @resultJson, last_error = NULL, last_error_at = NULL, " +
            "finished_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP " +
            "WHERE run_id = @runId AND step_key = @stepKey",
    );

    private markFailedRetryStmt = db.prepare<{
        runId: number;
        stepKey: BootstrapStepKey;
        status: BootstrapStepStatus;
        attempts: number;
        nextAttemptAt: number;
        lastError: string;
        nowMs: number;
    }>(
        "UPDATE bootstrap_run_steps SET " +
            "status = @status, attempts = @attempts, next_attempt_at = @nextAttemptAt, " +
            "last_error = @lastError, last_error_at = @nowMs, updated_at = CURRENT_TIMESTAMP " +
            "WHERE run_id = @runId AND step_key = @stepKey",
    );

    private markFailedTerminalStmt = db.prepare<{
        runId: number;
        stepKey: BootstrapStepKey;
        status: BootstrapStepStatus;
        attempts: number;
        lastError: string;
        nowMs: number;
    }>(
        "UPDATE bootstrap_run_steps SET " +
            "status = @status, attempts = @attempts, last_error = @lastError, last_error_at = @nowMs, " +
            "finished_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP " +
            "WHERE run_id = @runId AND step_key = @stepKey",
    );

    private updateProgressStmt = db.prepare<{
        runId: number;
        stepKey: BootstrapStepKey;
        completed: number;
        total: number | null;
    }>(
        "UPDATE bootstrap_run_steps SET " +
            "progress_completed = @completed, progress_total = @total, updated_at = CURRENT_TIMESTAMP " +
            "WHERE run_id = @runId AND step_key = @stepKey",
    );

    getStep(
        runId: number,
        stepKey: BootstrapStepKey,
    ): BootstrapStepRecord | null {
        const row = this.selectStepStmt.get({
            runId,
            stepKey,
        }) as BootstrapStepDbRow | undefined;
        return row ? mapStep(row) : null;
    }

    listRunSteps(runId: number): BootstrapStepRecord[] {
        const rows = this.selectRunStepsStmt.all({
            runId,
        }) as BootstrapStepDbRow[];
        return rows.map(mapStep);
    }

    markStepReady(runId: number, stepKey: BootstrapStepKey): void {
        this.markReadyStmt.run({
            runId,
            stepKey,
            status: BOOTSTRAP_STEP_STATUS.Ready,
            pendingStatus: BOOTSTRAP_STEP_STATUS.Pending,
        });
    }

    markStepRunning(runId: number, stepKey: BootstrapStepKey): void {
        this.markRunningStmt.run({
            runId,
            stepKey,
            status: BOOTSTRAP_STEP_STATUS.Running,
        });
    }

    markStepSucceeded(
        runId: number,
        stepKey: BootstrapStepKey,
        progress?: BootstrapStepProgress,
    ): void {
        const completed = progress?.completed ?? 1;
        const total = progress?.total ?? completed;
        this.markSucceededStmt.run({
            runId,
            stepKey,
            status: BOOTSTRAP_STEP_STATUS.Succeeded,
            completed,
            total,
            resultJson: JSON.stringify({ completed, total }),
        });
    }

    markStepSkipped(
        runId: number,
        stepKey: BootstrapStepKey,
        reason: string,
    ): void {
        this.markSkippedStmt.run({
            runId,
            stepKey,
            status: BOOTSTRAP_STEP_STATUS.Skipped,
            resultJson: JSON.stringify({ reason }),
        });
    }

    markStepFailedRetry(input: {
        runId: number;
        stepKey: BootstrapStepKey;
        attempts: number;
        nextAttemptAt: number;
        error: string;
    }): void {
        this.markFailedRetryStmt.run({
            ...input,
            status: BOOTSTRAP_STEP_STATUS.FailedRetry,
            lastError: input.error,
            nowMs: Date.now(),
        });
    }

    markStepFailedTerminal(input: {
        runId: number;
        stepKey: BootstrapStepKey;
        attempts: number;
        error: string;
    }): void {
        this.markFailedTerminalStmt.run({
            ...input,
            status: BOOTSTRAP_STEP_STATUS.FailedTerminal,
            lastError: input.error,
            nowMs: Date.now(),
        });
    }

    updateStepProgress(
        runId: number,
        stepKey: BootstrapStepKey,
        progress: BootstrapStepProgress,
    ): void {
        this.updateProgressStmt.run({
            runId,
            stepKey,
            completed: progress.completed,
            total: progress.total,
        });
    }

    isStepPaused(runId: number, stepKey: BootstrapStepKey): boolean {
        return (
            this.getStep(runId, stepKey)?.status ===
            BOOTSTRAP_STEP_STATUS.Paused
        );
    }
}

function mapStep(row: BootstrapStepDbRow): BootstrapStepRecord {
    return {
        runId: row.run_id,
        stepKey: row.step_key,
        status: row.status,
        blocking: row.blocking === 1,
        dependsOn: parseBootstrapStepDependencies(row.depends_on_json),
        progressCompleted: row.progress_completed,
        progressTotal: row.progress_total,
        attempts: row.attempts,
        lastError: row.last_error,
    };
}
