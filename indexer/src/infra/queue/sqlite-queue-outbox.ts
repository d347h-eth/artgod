import { db } from "@artgod/shared/database";
import type { JobEnvelope } from "../../domain/jobs.js";
import {
    QUEUE_OUTBOX_STATUS,
    type QueueOutboxStatus,
} from "../../domain/queue-outbox.js";
import type { QueueName } from "../../domain/queues.js";

type QueueOutboxIdRow = {
    outbox_id: number;
};

type QueueOutboxDueDbRow = {
    outbox_id: number;
    queue_name: QueueName;
    job_id: string;
    job_kind: string;
    job_json: string;
    chain_id: number;
    collection_id: number | null;
    attempts: number;
};

// QueueOutboxDueRecord is the storage projection consumed by the drainer.
export type QueueOutboxDueRecord = {
    outboxId: number;
    queueName: QueueName;
    jobId: string;
    jobKind: string;
    jobJson: string;
    chainId: number;
    collectionId: number | null;
    attempts: number;
};

// Persists queue envelopes before workers publish them to the broker.
export class SqliteQueueOutbox {
    private insertJobStmt = db.prepare<{
        queueName: QueueName;
        jobId: string;
        jobKind: string;
        jobJson: string;
        chainId: number;
        collectionId: number | null;
        status: QueueOutboxStatus;
        nextAttemptAt: number;
    }>(
        "INSERT OR IGNORE INTO queue_outbox " +
            "(queue_name, job_id, job_kind, job_json, chain_id, collection_id, status, attempts, next_attempt_at) " +
            "VALUES (@queueName, @jobId, @jobKind, @jobJson, @chainId, @collectionId, @status, 0, @nextAttemptAt)",
    );
    private selectJobIdStmt = db.prepare<{
        queueName: QueueName;
        jobId: string;
    }>(
        "SELECT outbox_id FROM queue_outbox " +
            "WHERE queue_name = @queueName AND job_id = @jobId LIMIT 1",
    );
    private selectDueStmt = db.prepare<{
        pendingStatus: QueueOutboxStatus;
        failedRetryStatus: QueueOutboxStatus;
        nowMs: number;
        limit: number;
    }>(
        "SELECT outbox_id, queue_name, job_id, job_kind, job_json, chain_id, collection_id, attempts " +
            "FROM queue_outbox " +
            "WHERE status IN (@pendingStatus, @failedRetryStatus) " +
            "AND next_attempt_at <= @nowMs " +
            "ORDER BY next_attempt_at ASC, outbox_id ASC LIMIT @limit",
    );
    private markSentStmt = db.prepare<{
        outboxId: number;
        sentStatus: QueueOutboxStatus;
    }>(
        "UPDATE queue_outbox SET status = @sentStatus, sent_at = CURRENT_TIMESTAMP, " +
            "last_error = NULL, last_error_at = NULL, updated_at = CURRENT_TIMESTAMP " +
            "WHERE outbox_id = @outboxId",
    );
    private markFailedStmt = db.prepare<{
        outboxId: number;
        attempts: number;
        status: QueueOutboxStatus;
        nextAttemptAt: number;
        lastError: string;
        lastErrorAt: number;
    }>(
        "UPDATE queue_outbox SET status = @status, attempts = @attempts, " +
            "next_attempt_at = @nextAttemptAt, last_error = @lastError, " +
            "last_error_at = @lastErrorAt, updated_at = CURRENT_TIMESTAMP " +
            "WHERE outbox_id = @outboxId",
    );

    enqueueJob<TPayload>(
        job: JobEnvelope<TPayload>,
        nextAttemptAt: number = 0,
    ): number {
        this.insertJobStmt.run({
            queueName: job.queue,
            jobId: job.jobId,
            jobKind: job.kind,
            jobJson: JSON.stringify(job),
            chainId: job.chainId,
            collectionId: job.collectionId ?? null,
            status: QUEUE_OUTBOX_STATUS.Pending,
            nextAttemptAt,
        });
        const row = this.selectJobIdStmt.get({
            queueName: job.queue,
            jobId: job.jobId,
        }) as QueueOutboxIdRow | undefined;
        if (!row) {
            throw new Error(
                "Queue outbox insert did not return a persisted row",
            );
        }
        return row.outbox_id;
    }

    listDue(nowMs: number, limit: number): QueueOutboxDueRecord[] {
        const rows = this.selectDueStmt.all({
            pendingStatus: QUEUE_OUTBOX_STATUS.Pending,
            failedRetryStatus: QUEUE_OUTBOX_STATUS.FailedRetry,
            nowMs,
            limit,
        }) as QueueOutboxDueDbRow[];
        return rows.map((row) => ({
            outboxId: row.outbox_id,
            queueName: row.queue_name,
            jobId: row.job_id,
            jobKind: row.job_kind,
            jobJson: row.job_json,
            chainId: row.chain_id,
            collectionId: row.collection_id,
            attempts: row.attempts,
        }));
    }

    markSent(outboxId: number): void {
        this.markSentStmt.run({
            outboxId,
            sentStatus: QUEUE_OUTBOX_STATUS.Sent,
        });
    }

    markFailed(input: {
        outboxId: number;
        attempts: number;
        nextAttemptAt: number;
        lastError: string;
        terminal: boolean;
    }): void {
        this.markFailedStmt.run({
            outboxId: input.outboxId,
            attempts: input.attempts,
            status: input.terminal
                ? QUEUE_OUTBOX_STATUS.FailedTerminal
                : QUEUE_OUTBOX_STATUS.FailedRetry,
            nextAttemptAt: input.nextAttemptAt,
            lastError: input.lastError,
            lastErrorAt: Date.now(),
        });
    }
}
