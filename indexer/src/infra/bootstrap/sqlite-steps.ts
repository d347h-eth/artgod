import { db } from "@artgod/shared/database";
import {
    BOOTSTRAP_STEP_STATUS,
    parseBootstrapStepDependencies,
    type BootstrapStepKey,
    type BootstrapStepStatus,
} from "@artgod/shared/bootstrap/pipeline";
import type {
    BootstrapDueStepRunQuery,
    BootstrapNextDueStepQuery,
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
    next_attempt_at: number;
    lease_owner: string | null;
    lease_until: number | null;
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
        "SELECT run_id, step_key, status, blocking, depends_on_json, next_attempt_at, lease_owner, lease_until, progress_completed, progress_total, attempts, last_error " +
            "FROM bootstrap_run_steps WHERE run_id = @runId AND step_key = @stepKey LIMIT 1",
    );

    private selectRunStepsStmt = db.prepare<{ runId: number }>(
        "SELECT run_id, step_key, status, blocking, depends_on_json, next_attempt_at, lease_owner, lease_until, progress_completed, progress_total, attempts, last_error " +
            "FROM bootstrap_run_steps WHERE run_id = @runId ORDER BY rowid ASC",
    );

    private markReadyStmt = db.prepare<{
        runId: number;
        stepKey: BootstrapStepKey;
        status: BootstrapStepStatus;
        pendingStatus: BootstrapStepStatus;
    }>(
        "UPDATE bootstrap_run_steps SET " +
            "status = @status, next_attempt_at = 0, lease_owner = NULL, lease_until = NULL, updated_at = CURRENT_TIMESTAMP " +
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

    private releaseReadyStmt = db.prepare<{
        runId: number;
        stepKey: BootstrapStepKey;
        leaseOwner: string;
        status: BootstrapStepStatus;
        nextAttemptAt: number;
        runningStatus: BootstrapStepStatus;
    }>(
        "UPDATE bootstrap_run_steps SET " +
            "status = @status, next_attempt_at = @nextAttemptAt, lease_owner = NULL, lease_until = NULL, updated_at = CURRENT_TIMESTAMP " +
            "WHERE run_id = @runId AND step_key = @stepKey AND status = @runningStatus AND lease_owner = @leaseOwner",
    );

    private releaseRunningStmt = db.prepare<{
        runId: number;
        stepKey: BootstrapStepKey;
        leaseOwner: string;
        nextAttemptAt: number;
        runningStatus: BootstrapStepStatus;
    }>(
        "UPDATE bootstrap_run_steps SET " +
            "next_attempt_at = @nextAttemptAt, lease_owner = NULL, lease_until = @nextAttemptAt, updated_at = CURRENT_TIMESTAMP " +
            "WHERE run_id = @runId AND step_key = @stepKey AND status = @runningStatus AND lease_owner = @leaseOwner",
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
            "lease_owner = NULL, lease_until = NULL, last_error = NULL, last_error_at = NULL, finished_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP " +
            "WHERE run_id = @runId AND step_key = @stepKey",
    );

    private markSkippedStmt = db.prepare<{
        runId: number;
        stepKey: BootstrapStepKey;
        status: BootstrapStepStatus;
        resultJson: string;
    }>(
        "UPDATE bootstrap_run_steps SET " +
            "status = @status, result_json = @resultJson, lease_owner = NULL, lease_until = NULL, last_error = NULL, last_error_at = NULL, " +
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
            "lease_owner = NULL, lease_until = NULL, last_error = @lastError, last_error_at = @nowMs, updated_at = CURRENT_TIMESTAMP " +
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
            "status = @status, attempts = @attempts, lease_owner = NULL, lease_until = NULL, last_error = @lastError, last_error_at = @nowMs, " +
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

    listDueStepRunIds(input: BootstrapDueStepRunQuery): number[] {
        if (input.stepKeys.length === 0) {
            return [];
        }
        const stepKeyPlaceholders = input.stepKeys.map(() => "?").join(", ");
        const sql =
            "SELECT DISTINCT s.run_id " +
            "FROM bootstrap_run_steps s " +
            "JOIN bootstrap_runs r ON r.run_id = s.run_id " +
            `WHERE r.chain_id = ? AND s.step_key IN (${stepKeyPlaceholders}) ` +
            "AND (" +
            "(s.status IN (?, ?) AND s.next_attempt_at <= ? AND (s.lease_until IS NULL OR s.lease_until <= ?)) " +
            "OR (s.status = ? AND s.lease_until IS NOT NULL AND s.lease_until <= ?)" +
            ") ORDER BY s.run_id ASC LIMIT ?";
        const rows = db.raw
            .prepare(sql)
            .all(
                input.chainId,
                ...input.stepKeys,
                BOOTSTRAP_STEP_STATUS.Ready,
                BOOTSTRAP_STEP_STATUS.FailedRetry,
                input.nowMs,
                input.nowMs,
                BOOTSTRAP_STEP_STATUS.Running,
                input.nowMs,
                Math.max(1, input.limit),
            ) as Array<{ run_id: number }>;
        return rows.map((row) => row.run_id);
    }

    getNextDueStepAt(input: BootstrapNextDueStepQuery): number | null {
        if (input.stepKeys.length === 0) {
            return null;
        }
        const stepKeyPlaceholders = input.stepKeys.map(() => "?").join(", ");
        const sql =
            "SELECT MIN(CASE WHEN s.status = ? THEN s.lease_until ELSE s.next_attempt_at END) AS next_due_at " +
            "FROM bootstrap_run_steps s " +
            "JOIN bootstrap_runs r ON r.run_id = s.run_id " +
            `WHERE r.chain_id = ? AND s.step_key IN (${stepKeyPlaceholders}) ` +
            "AND (" +
            "s.status IN (?, ?) " +
            "OR (s.status = ? AND s.lease_until IS NOT NULL)" +
            ")";
        const row = db.raw
            .prepare(sql)
            .get(
                BOOTSTRAP_STEP_STATUS.Running,
                input.chainId,
                ...input.stepKeys,
                BOOTSTRAP_STEP_STATUS.Ready,
                BOOTSTRAP_STEP_STATUS.FailedRetry,
                BOOTSTRAP_STEP_STATUS.Running,
            ) as { next_due_at: number | null } | undefined;
        return row?.next_due_at ?? null;
    }

    claimReadySteps(input: {
        runId: number;
        stepKeys: readonly BootstrapStepKey[];
        leaseOwner: string;
        leaseUntil: number;
        nowMs: number;
        limit: number;
    }): BootstrapStepRecord[] {
        if (input.stepKeys.length === 0) {
            return [];
        }
        const claim = db.raw.transaction(() => {
            const candidates = selectClaimCandidates(input);
            const claimed: BootstrapStepRecord[] = [];
            for (const candidate of candidates) {
                const updated = updateClaimCandidate(input, candidate);
                if (updated <= 0) {
                    continue;
                }
                const step = this.getStep(candidate.run_id, candidate.step_key);
                if (step) {
                    claimed.push(step);
                }
            }
            return claimed;
        });
        return claim();
    }

    releaseStepLease(input: {
        runId: number;
        stepKey: BootstrapStepKey;
        leaseOwner: string;
        nextAttemptAt: number;
    }): void {
        this.releaseReadyStmt.run({
            ...input,
            status: BOOTSTRAP_STEP_STATUS.Ready,
            runningStatus: BOOTSTRAP_STEP_STATUS.Running,
        });
    }

    releaseStepLeaseAsRunning(input: {
        runId: number;
        stepKey: BootstrapStepKey;
        leaseOwner: string;
        nextAttemptAt: number;
    }): void {
        this.releaseRunningStmt.run({
            ...input,
            runningStatus: BOOTSTRAP_STEP_STATUS.Running,
        });
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
        nextAttemptAt: row.next_attempt_at,
        leaseOwner: row.lease_owner,
        leaseUntil: row.lease_until,
        progressCompleted: row.progress_completed,
        progressTotal: row.progress_total,
        attempts: row.attempts,
        lastError: row.last_error,
    };
}

function selectClaimCandidates(input: {
    runId: number;
    stepKeys: readonly BootstrapStepKey[];
    nowMs: number;
    limit: number;
}): BootstrapStepDbRow[] {
    const stepKeyPlaceholders = input.stepKeys.map(() => "?").join(", ");
    const sql =
        "SELECT run_id, step_key, status, blocking, depends_on_json, next_attempt_at, lease_owner, lease_until, progress_completed, progress_total, attempts, last_error " +
        "FROM bootstrap_run_steps " +
        `WHERE run_id = ? AND step_key IN (${stepKeyPlaceholders}) ` +
        "AND (" +
        "(status IN (?, ?) AND next_attempt_at <= ? AND (lease_until IS NULL OR lease_until <= ?)) " +
        "OR (status = ? AND lease_until IS NOT NULL AND lease_until <= ?)" +
        ") ORDER BY rowid ASC LIMIT ?";
    return db.raw.prepare(sql).all(
        input.runId,
        ...input.stepKeys,
        BOOTSTRAP_STEP_STATUS.Ready,
        BOOTSTRAP_STEP_STATUS.FailedRetry,
        input.nowMs,
        input.nowMs,
        BOOTSTRAP_STEP_STATUS.Running,
        input.nowMs,
        Math.max(1, input.limit),
    ) as BootstrapStepDbRow[];
}

function updateClaimCandidate(
    input: {
        leaseOwner: string;
        leaseUntil: number;
        nowMs: number;
    },
    candidate: BootstrapStepDbRow,
): number {
    const result = db.raw.prepare(
        "UPDATE bootstrap_run_steps SET " +
            "status = ?, lease_owner = ?, lease_until = ?, started_at = COALESCE(started_at, CURRENT_TIMESTAMP), updated_at = CURRENT_TIMESTAMP " +
            "WHERE run_id = ? AND step_key = ? AND (" +
            "(status IN (?, ?) AND next_attempt_at <= ? AND (lease_until IS NULL OR lease_until <= ?)) " +
            "OR (status = ? AND lease_until IS NOT NULL AND lease_until <= ?)" +
            ")",
    ).run(
        BOOTSTRAP_STEP_STATUS.Running,
        input.leaseOwner,
        input.leaseUntil,
        candidate.run_id,
        candidate.step_key,
        BOOTSTRAP_STEP_STATUS.Ready,
        BOOTSTRAP_STEP_STATUS.FailedRetry,
        input.nowMs,
        input.nowMs,
        BOOTSTRAP_STEP_STATUS.Running,
        input.nowMs,
    );
    return result.changes;
}
