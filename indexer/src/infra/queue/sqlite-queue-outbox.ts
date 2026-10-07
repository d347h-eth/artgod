import { db } from "@artgod/shared/database";
import type { JobEnvelope, QueuePublication } from "../../domain/jobs.js";
import {
    QUEUE_OUTBOX_STATUS,
    QUEUE_OUTBOX_RETRY_POLICY,
    type QueueOutboxRetryPolicy,
    type QueueOutboxStatus,
} from "../../domain/queue-outbox.js";
import type { QueueName } from "../../domain/queues.js";
import {
    SYNC_FOLLOW_UP_KIND,
    type SyncFollowUp,
} from "../../domain/sync-follow-ups.js";

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
    retry_policy: QueueOutboxRetryPolicy;
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
    retryPolicy: QueueOutboxRetryPolicy;
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
        retryPolicy: QueueOutboxRetryPolicy;
        blockNumber: number | null;
        blockHash: string | null;
    }>(
        "INSERT OR IGNORE INTO queue_outbox " +
            "(queue_name, job_id, job_kind, job_json, chain_id, collection_id, status, attempts, next_attempt_at, retry_policy, sync_block_number, sync_block_hash) " +
            "VALUES (@queueName, @jobId, @jobKind, @jobJson, @chainId, @collectionId, @status, 0, @nextAttemptAt, @retryPolicy, @blockNumber, @blockHash)",
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
        "SELECT outbox_id, queue_name, job_id, job_kind, job_json, chain_id, collection_id, attempts, retry_policy " +
            "FROM queue_outbox " +
            "WHERE status IN (@pendingStatus, @failedRetryStatus) " +
            "AND next_attempt_at <= @nowMs " +
            "ORDER BY next_attempt_at ASC, outbox_id ASC LIMIT @limit",
    );
    private markSentStmt = db.prepare<{
        outboxId: number;
        sentStatus: QueueOutboxStatus;
        streamId: string | null;
        sequence: number | null;
    }>(
        "UPDATE queue_outbox SET status = @sentStatus, sent_at = CURRENT_TIMESTAMP, " +
            "last_error = NULL, last_error_at = NULL, updated_at = CURRENT_TIMESTAMP, " +
            "publication_stream_id=@streamId, publication_sequence=@sequence WHERE outbox_id = @outboxId",
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
        return this.insertJob({
            job,
            nextAttemptAt,
            retryPolicy: QUEUE_OUTBOX_RETRY_POLICY.Bounded,
            blockNumber: null,
            blockHash: null,
        });
    }

    // Called inside the sync data transaction. Revision-qualified IDs allow new
    // canonical events at the same height/log position after an earlier rollback.
    enqueueSyncFollowUp(input: {
        followUp: SyncFollowUp;
        revision: number;
    }): number {
        const { followUp } = input;
        const event = followUp.kind === SYNC_FOLLOW_UP_KIND.Event;
        const job: JobEnvelope = {
            ...followUp.job,
            jobId: `${followUp.job.jobId}:chain-revision:${input.revision}`,
            ...(event ? { onchainBlock: followUp.block } : {}),
        };
        return this.insertJob({
            job,
            nextAttemptAt: 0,
            retryPolicy: QUEUE_OUTBOX_RETRY_POLICY.Required,
            blockNumber: event ? followUp.block.blockNumber : null,
            blockHash: event ? followUp.block.blockHash : null,
        });
    }

    private insertJob(input: {
        job: JobEnvelope;
        nextAttemptAt: number;
        retryPolicy: QueueOutboxRetryPolicy;
        blockNumber: number | null;
        blockHash: string | null;
    }): number {
        const { job } = input;
        this.insertJobStmt.run({
            queueName: job.queue,
            jobId: job.jobId,
            jobKind: job.kind,
            jobJson: JSON.stringify(job),
            chainId: job.chainId,
            collectionId: job.collectionId ?? null,
            status: QUEUE_OUTBOX_STATUS.Pending,
            nextAttemptAt: input.nextAttemptAt,
            retryPolicy: input.retryPolicy,
            blockNumber: input.blockNumber,
            blockHash: input.blockHash,
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
            retryPolicy: row.retry_policy,
        }));
    }

    markSent(outboxId: number, publication?: QueuePublication): void {
        this.markSentStmt.run({
            outboxId,
            sentStatus: QUEUE_OUTBOX_STATUS.Sent,
            streamId: publication?.streamId ?? null,
            sequence: publication?.sequence ?? null,
        });
    }

    // Published sync work no longer needs an outbox owner. Stable envelope IDs
    // and idempotent consumers handle a late duplicate acquisition/publication.
    removePublishedSyncFollowUp(outboxId: number): void {
        db.prepare(
            "DELETE FROM queue_outbox WHERE outbox_id = ? AND retry_policy = ?",
        ).run(outboxId, QUEUE_OUTBOX_RETRY_POLICY.Required);
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
