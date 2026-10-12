import { db } from "@artgod/shared/database";
import { BOOTSTRAP_RUN_EVENT_CODE } from "@artgod/shared/bootstrap/run-events";
import {
    BOOTSTRAP_STEP_STATUS,
    BOOTSTRAP_STEP_KEY,
    BOOTSTRAP_RUN_STATUS,
    parseBootstrapStepDependencies,
    type BootstrapRunStatus,
    type BootstrapStepKey,
    type BootstrapStepStatus,
} from "@artgod/shared/bootstrap/pipeline";
import type {
    BootstrapDueStepRunQuery,
    BootstrapNextDueStepQuery,
    BootstrapStepProgress,
    BootstrapStepRecord,
    BootstrapStepsPort,
    BootstrapEnumerationConfirmation,
} from "../../ports/bootstrap-steps.js";
import type {
    BootstrapEnumerationClaim,
    BootstrapEnumerationStepsPort,
} from "../../application/bootstrap-enumeration-executor.js";

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
    result_json: string | null;
    attempts: number;
    last_error: string | null;
};

// Running work becomes due at lease expiry; ready/retry work at its deadline.
// Keep run selection and poll timing on the same durable clock.
const BOOTSTRAP_STEP_DUE_AT_SQL =
    "CASE WHEN s.status = ? THEN s.lease_until ELSE s.next_attempt_at END";

// SQLite adapter for the durable bootstrap_run_steps orchestration journal.
export class SqliteBootstrapSteps
    implements BootstrapStepsPort, BootstrapEnumerationStepsPort
{
    constructor(private readonly nowMs: () => number = Date.now) {}

    ownsEnumerationLease({
        run,
        anchor,
        leaseOwner,
    }: BootstrapEnumerationClaim): boolean {
        return (
            db
                .prepare(
                    "SELECT 1 FROM bootstrap_run_steps s JOIN bootstrap_runs r ON r.run_id = s.run_id " +
                        "WHERE s.run_id = @runId AND s.step_key = @stepKey AND s.status = @running " +
                        "AND s.lease_owner = @leaseOwner AND s.lease_until > @nowMs " +
                        "AND r.status != @failed AND r.chain_id = @chainId AND r.collection_id = @collectionId " +
                        "AND lower(r.request_address) = lower(@address) " +
                        "AND r.anchor_block = @anchorBlock AND r.anchor_block_hash = @anchorHash",
                )
                .get({
                    runId: run.runId,
                    stepKey: BOOTSTRAP_STEP_KEY.Enumeration,
                    running: BOOTSTRAP_STEP_STATUS.Running,
                    failed: BOOTSTRAP_RUN_STATUS.Failed,
                    chainId: run.chainId,
                    collectionId: run.collectionId,
                    address: run.requestAddress,
                    anchorBlock: anchor.anchorBlock,
                    anchorHash: anchor.anchorHash,
                    leaseOwner,
                    nowMs: this.nowMs(),
                }) !== undefined
        );
    }

    completeEnumeration(
        input: Parameters<
            BootstrapEnumerationStepsPort["completeEnumeration"]
        >[0],
    ): boolean {
        return db.writeTransaction(() => {
            if (!this.ownsEnumerationLease(input)) return false;
            const { run, anchor, tokenCount, firstTokenId } = input;
            // This small run-owned output outlives snapshot/task cleanup. Task
            // counts on resume cannot reconstruct or replace a confirmed token.
            const result = {
                completed: tokenCount,
                total: tokenCount,
                ...(firstTokenId === undefined
                    ? {}
                    : ({
                          firstTokenId,
                          anchorBlock: anchor.anchorBlock,
                          anchorHash: anchor.anchorHash,
                      } satisfies BootstrapEnumerationConfirmation)),
            };
            db.prepare(
                "INSERT INTO bootstrap_run_events (run_id, chain_id, collection_id, event_code, event_level, message, payload_json) " +
                    "VALUES (?, ?, ?, ?, ?, ?, ?)",
            ).run(
                run.runId,
                run.chainId,
                run.collectionId,
                BOOTSTRAP_RUN_EVENT_CODE.MetadataEnumerationCompleted,
                "info",
                "Token enumeration completed",
                JSON.stringify({
                    enumerationMode: run.enumerationMode,
                    tokenCount,
                    elapsedMs: input.elapsedMs,
                }),
            );
            return (
                db
                    .prepare(
                        "UPDATE bootstrap_run_steps SET status = @succeeded, progress_completed = @count, progress_total = @count, " +
                            "result_json = json_patch(CASE WHEN json_valid(result_json) AND json_type(result_json) = 'object' " +
                            "THEN result_json ELSE '{}' END, @resultJson), " +
                            "lease_owner = NULL, lease_until = NULL, next_attempt_at = 0, last_error = NULL, last_error_at = NULL, " +
                            "finished_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP " +
                            "WHERE run_id = @runId AND step_key = @stepKey",
                    )
                    .run({
                        runId: run.runId,
                        stepKey: BOOTSTRAP_STEP_KEY.Enumeration,
                        succeeded: BOOTSTRAP_STEP_STATUS.Succeeded,
                        count: tokenCount,
                        resultJson: JSON.stringify(result),
                    }).changes === 1
            );
        })();
    }

    private selectStepStmt = db.prepare<{
        runId: number;
        stepKey: BootstrapStepKey;
    }>(
        "SELECT run_id, step_key, status, blocking, depends_on_json, next_attempt_at, lease_owner, lease_until, progress_completed, progress_total, result_json, attempts, last_error " +
            "FROM bootstrap_run_steps WHERE run_id = @runId AND step_key = @stepKey LIMIT 1",
    );

    private selectRunStepsStmt = db.prepare<{ runId: number }>(
        "SELECT run_id, step_key, status, blocking, depends_on_json, next_attempt_at, lease_owner, lease_until, progress_completed, progress_total, result_json, attempts, last_error " +
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
        succeededStatus: BootstrapStepStatus;
        skippedStatus: BootstrapStepStatus;
        failedTerminalStatus: BootstrapStepStatus;
        pausedStatus: BootstrapStepStatus;
    }>(
        "UPDATE bootstrap_run_steps SET " +
            "status = @status, started_at = COALESCE(started_at, CURRENT_TIMESTAMP), updated_at = CURRENT_TIMESTAMP " +
            "WHERE run_id = @runId AND step_key = @stepKey " +
            "AND status NOT IN (@succeededStatus, @skippedStatus, @failedTerminalStatus, @pausedStatus)",
    );

    private markDelegatedRunningStmt = db.prepare<{
        runId: number;
        stepKey: BootstrapStepKey;
        status: BootstrapStepStatus;
        healthCheckAt: number;
        succeededStatus: BootstrapStepStatus;
        skippedStatus: BootstrapStepStatus;
        failedTerminalStatus: BootstrapStepStatus;
        pausedStatus: BootstrapStepStatus;
    }>(
        "UPDATE bootstrap_run_steps SET " +
            "status = @status, next_attempt_at = @healthCheckAt, lease_owner = NULL, lease_until = @healthCheckAt, " +
            "started_at = COALESCE(started_at, CURRENT_TIMESTAMP), updated_at = CURRENT_TIMESTAMP " +
            "WHERE run_id = @runId AND step_key = @stepKey " +
            "AND status NOT IN (@succeededStatus, @skippedStatus, @failedTerminalStatus, @pausedStatus)",
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
    private renewLeaseStmt = db.prepare<{
        runId: number;
        stepKey: BootstrapStepKey;
        leaseOwner: string;
        leaseUntil: number;
        runningStatus: BootstrapStepStatus;
        failedStatus: BootstrapRunStatus;
        nowMs: number;
    }>(
        "UPDATE bootstrap_run_steps SET " +
            "lease_until = @leaseUntil, updated_at = CURRENT_TIMESTAMP " +
            "WHERE run_id = @runId AND step_key = @stepKey " +
            "AND status = @runningStatus AND lease_owner = @leaseOwner AND lease_until > @nowMs " +
            "AND EXISTS (SELECT 1 FROM bootstrap_runs r WHERE r.run_id = @runId AND r.status != @failedStatus)",
    );

    private markSucceededStmt = db.prepare<{
        runId: number;
        stepKey: BootstrapStepKey;
        status: BootstrapStepStatus;
        completed: number;
        total: number | null;
        resultJson: string | null;
        succeededStatus: BootstrapStepStatus;
        skippedStatus: BootstrapStepStatus;
        failedTerminalStatus: BootstrapStepStatus;
        pausedStatus: BootstrapStepStatus;
    }>(
        "UPDATE bootstrap_run_steps SET " +
            "status = @status, progress_completed = @completed, progress_total = @total, result_json = @resultJson, " +
            "lease_owner = NULL, lease_until = NULL, last_error = NULL, last_error_at = NULL, finished_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP " +
            "WHERE run_id = @runId AND step_key = @stepKey " +
            "AND status NOT IN (@succeededStatus, @skippedStatus, @failedTerminalStatus, @pausedStatus)",
    );

    private markSkippedStmt = db.prepare<{
        runId: number;
        stepKey: BootstrapStepKey;
        status: BootstrapStepStatus;
        resultJson: string;
        succeededStatus: BootstrapStepStatus;
        skippedStatus: BootstrapStepStatus;
        failedTerminalStatus: BootstrapStepStatus;
        pausedStatus: BootstrapStepStatus;
    }>(
        "UPDATE bootstrap_run_steps SET " +
            "status = @status, result_json = @resultJson, lease_owner = NULL, lease_until = NULL, last_error = NULL, last_error_at = NULL, " +
            "finished_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP " +
            "WHERE run_id = @runId AND step_key = @stepKey " +
            "AND status NOT IN (@succeededStatus, @skippedStatus, @failedTerminalStatus, @pausedStatus)",
    );

    private markFailedRetryStmt = db.prepare<{
        runId: number;
        stepKey: BootstrapStepKey;
        status: BootstrapStepStatus;
        attempts: number;
        nextAttemptAt: number;
        lastError: string;
        nowMs: number;
        succeededStatus: BootstrapStepStatus;
        skippedStatus: BootstrapStepStatus;
        failedTerminalStatus: BootstrapStepStatus;
        pausedStatus: BootstrapStepStatus;
    }>(
        "UPDATE bootstrap_run_steps SET " +
            "status = @status, attempts = @attempts, next_attempt_at = @nextAttemptAt, " +
            "lease_owner = NULL, lease_until = NULL, last_error = @lastError, last_error_at = @nowMs, updated_at = CURRENT_TIMESTAMP " +
            "WHERE run_id = @runId AND step_key = @stepKey " +
            "AND status NOT IN (@succeededStatus, @skippedStatus, @failedTerminalStatus, @pausedStatus)",
    );

    private markFailedTerminalStmt = db.prepare<{
        runId: number;
        stepKey: BootstrapStepKey;
        status: BootstrapStepStatus;
        attempts: number;
        lastError: string;
        nowMs: number;
        succeededStatus: BootstrapStepStatus;
        skippedStatus: BootstrapStepStatus;
        failedTerminalStatus: BootstrapStepStatus;
        pausedStatus: BootstrapStepStatus;
    }>(
        "UPDATE bootstrap_run_steps SET " +
            "status = @status, attempts = @attempts, lease_owner = NULL, lease_until = NULL, last_error = @lastError, last_error_at = @nowMs, " +
            "finished_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP " +
            "WHERE run_id = @runId AND step_key = @stepKey " +
            "AND status NOT IN (@succeededStatus, @skippedStatus, @failedTerminalStatus, @pausedStatus)",
    );

    private updateProgressStmt = db.prepare<{
        runId: number;
        stepKey: BootstrapStepKey;
        completed: number;
        total: number | null;
        succeededStatus: BootstrapStepStatus;
        skippedStatus: BootstrapStepStatus;
        failedTerminalStatus: BootstrapStepStatus;
        pausedStatus: BootstrapStepStatus;
    }>(
        "UPDATE bootstrap_run_steps SET " +
            "progress_completed = @completed, progress_total = @total, updated_at = CURRENT_TIMESTAMP " +
            "WHERE run_id = @runId AND step_key = @stepKey " +
            "AND status NOT IN (@succeededStatus, @skippedStatus, @failedTerminalStatus, @pausedStatus)",
    );

    private updateResultStmt = db.prepare<{
        runId: number;
        stepKey: BootstrapStepKey;
        resultJson: string;
    }>(
        "UPDATE bootstrap_run_steps SET " +
            "result_json = @resultJson, updated_at = CURRENT_TIMESTAMP " +
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
            `SELECT s.run_id, MIN(${BOOTSTRAP_STEP_DUE_AT_SQL}) AS next_due_at ` +
            "FROM bootstrap_run_steps s " +
            "JOIN bootstrap_runs r ON r.run_id = s.run_id " +
            `WHERE r.chain_id = ? AND r.status != ? AND s.step_key IN (${stepKeyPlaceholders}) ` +
            "AND (" +
            "(s.status IN (?, ?) AND s.next_attempt_at <= ? AND (s.lease_until IS NULL OR s.lease_until <= ?)) " +
            "OR (s.status = ? AND s.lease_until IS NOT NULL AND s.lease_until <= ?)" +
            ") GROUP BY s.run_id ORDER BY next_due_at ASC, s.run_id ASC LIMIT ?";
        const rows = db.raw
            .prepare(sql)
            .all(
                BOOTSTRAP_STEP_STATUS.Running,
                input.chainId,
                BOOTSTRAP_RUN_STATUS.Failed,
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
            `SELECT MIN(${BOOTSTRAP_STEP_DUE_AT_SQL}) AS next_due_at ` +
            "FROM bootstrap_run_steps s " +
            "JOIN bootstrap_runs r ON r.run_id = s.run_id " +
            `WHERE r.chain_id = ? AND r.status != ? AND s.step_key IN (${stepKeyPlaceholders}) ` +
            "AND (" +
            "s.status IN (?, ?) " +
            "OR (s.status = ? AND s.lease_until IS NOT NULL)" +
            ")";
        const row = db.raw
            .prepare(sql)
            .get(
                BOOTSTRAP_STEP_STATUS.Running,
                input.chainId,
                BOOTSTRAP_RUN_STATUS.Failed,
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
        const claim = db.writeTransaction(() => {
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

    renewStepLease(input: {
        runId: number;
        stepKey: BootstrapStepKey;
        leaseOwner: string;
        leaseUntil: number;
    }): void {
        this.renewLeaseStmt.run({
            ...input,
            nowMs: this.nowMs(),
            runningStatus: BOOTSTRAP_STEP_STATUS.Running,
            failedStatus: BOOTSTRAP_RUN_STATUS.Failed,
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
            ...protectedStatusParams(),
        });
    }

    markStepDelegatedRunning(input: {
        runId: number;
        stepKey: BootstrapStepKey;
        healthCheckAt: number;
    }): void {
        this.markDelegatedRunningStmt.run({
            ...input,
            status: BOOTSTRAP_STEP_STATUS.Running,
            ...protectedStatusParams(),
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
            ...protectedStatusParams(),
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
            ...protectedStatusParams(),
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
            ...protectedStatusParams(),
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
            ...protectedStatusParams(),
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
            ...protectedStatusParams(),
        });
    }

    updateStepResult(
        runId: number,
        stepKey: BootstrapStepKey,
        result: Record<string, unknown>,
    ): void {
        this.updateResultStmt.run({
            runId,
            stepKey,
            resultJson: JSON.stringify(result),
        });
    }

    isStepPaused(runId: number, stepKey: BootstrapStepKey): boolean {
        return (
            this.getStep(runId, stepKey)?.status ===
            BOOTSTRAP_STEP_STATUS.Paused
        );
    }
}

function protectedStatusParams(): {
    succeededStatus: BootstrapStepStatus;
    skippedStatus: BootstrapStepStatus;
    failedTerminalStatus: BootstrapStepStatus;
    pausedStatus: BootstrapStepStatus;
} {
    return {
        succeededStatus: BOOTSTRAP_STEP_STATUS.Succeeded,
        skippedStatus: BOOTSTRAP_STEP_STATUS.Skipped,
        failedTerminalStatus: BOOTSTRAP_STEP_STATUS.FailedTerminal,
        pausedStatus: BOOTSTRAP_STEP_STATUS.Paused,
    };
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
        resultJson: row.result_json,
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
        "SELECT run_id, step_key, status, blocking, depends_on_json, next_attempt_at, lease_owner, lease_until, progress_completed, progress_total, result_json, attempts, last_error " +
        "FROM bootstrap_run_steps " +
        `WHERE run_id = ? AND step_key IN (${stepKeyPlaceholders}) ` +
        "AND EXISTS (SELECT 1 FROM bootstrap_runs r WHERE r.run_id = bootstrap_run_steps.run_id AND r.status != ?) " +
        "AND (" +
        "(status IN (?, ?) AND next_attempt_at <= ? AND (lease_until IS NULL OR lease_until <= ?)) " +
        "OR (status = ? AND lease_until IS NOT NULL AND lease_until <= ?)" +
        ") ORDER BY rowid ASC LIMIT ?";
    return db.raw
        .prepare(sql)
        .all(
            input.runId,
            ...input.stepKeys,
            BOOTSTRAP_RUN_STATUS.Failed,
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
    const result = db.raw
        .prepare(
            "UPDATE bootstrap_run_steps SET " +
                "status = ?, lease_owner = ?, lease_until = ?, started_at = COALESCE(started_at, CURRENT_TIMESTAMP), updated_at = CURRENT_TIMESTAMP " +
                "WHERE run_id = ? AND step_key = ? AND (" +
                "(status IN (?, ?) AND next_attempt_at <= ? AND (lease_until IS NULL OR lease_until <= ?)) " +
                "OR (status = ? AND lease_until IS NOT NULL AND lease_until <= ?)" +
                ")",
        )
        .run(
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
