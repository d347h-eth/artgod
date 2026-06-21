import { db } from "@artgod/shared/database";
import type { CollectionExtensionKey } from "@artgod/shared/extensions";
import type { JobEnvelope } from "../../domain/jobs.js";
import {
    METADATA_REFRESH_EXTENSION_ARTIFACT_TASK_STATUS,
    METADATA_REFRESH_RUN_STATUS,
    type MetadataRefreshExtensionArtifactTerminalStatus,
    type MetadataRefreshRunStatus,
} from "../../domain/metadata-refresh-followups.js";
import type { MetadataStatsRecomputePayload } from "../../domain/domain-jobs.js";
import type { CollectionExtensionRefreshArtifactsPayload } from "../../domain/collection-extension-jobs.js";
import type { SqliteQueueOutbox } from "../queue/sqlite-queue-outbox.js";
import type {
    MetadataRefreshExtensionArtifactTaskSeed,
    MetadataRefreshFollowupRunInput,
} from "../../application/metadata/refresh-followups.js";

type MetadataRefreshRunStatusRow = {
    status: MetadataRefreshRunStatus;
};

type MetadataRefreshRunStatsJobRow = {
    stats_job_json: string;
};

type PendingTaskCountRow = {
    count: number;
};

// Persists metadata-refresh follow-up runs and their extension artifact tasks.
export class SqliteMetadataRefreshFollowups {
    private insertRunStmt = db.prepare<
        Omit<MetadataRefreshFollowupRunInput, "statsJob"> & {
            statsJobJson: string;
            status: MetadataRefreshRunStatus;
        }
    >(
        "INSERT OR IGNORE INTO metadata_refresh_runs " +
            "(run_id, chain_id, collection_id, reason, source_job_id, trace_id, stats_job_json, status) " +
            "VALUES (@runId, @chainId, @collectionId, @reason, @sourceJobId, @traceId, @statsJobJson, @status)",
    );
    private selectRunStatusStmt = db.prepare<{ runId: string }>(
        "SELECT status FROM metadata_refresh_runs WHERE run_id = @runId LIMIT 1",
    );
    private selectRunStatsJobStmt = db.prepare<{ runId: string }>(
        "SELECT stats_job_json FROM metadata_refresh_runs WHERE run_id = @runId LIMIT 1",
    );
    private finalizeRunStmt = db.prepare<{
        runId: string;
        finalizedStatus: MetadataRefreshRunStatus;
        statsQueueOutboxId: number;
        pendingStatus: MetadataRefreshRunStatus;
    }>(
        "UPDATE metadata_refresh_runs SET status = @finalizedStatus, " +
            "stats_queue_outbox_id = @statsQueueOutboxId, finalized_at = CURRENT_TIMESTAMP, " +
            "updated_at = CURRENT_TIMESTAMP WHERE run_id = @runId AND status = @pendingStatus",
    );
    private insertTaskStmt = db.prepare<
        MetadataRefreshExtensionArtifactTaskSeed & {
            runId: string;
            pendingStatus: string;
        }
    >(
        "INSERT OR IGNORE INTO metadata_refresh_extension_artifact_tasks " +
            "(run_id, chain_id, collection_id, contract_address, token_id, extension_key, status) " +
            "VALUES (@runId, @chainId, @collectionId, lower(@contract), @tokenId, @extensionKey, @pendingStatus)",
    );
    private markTaskTerminalStmt = db.prepare<{
        runId: string;
        tokenId: string;
        extensionKey: CollectionExtensionKey;
        status: MetadataRefreshExtensionArtifactTerminalStatus;
        pendingStatus: string;
    }>(
        "UPDATE metadata_refresh_extension_artifact_tasks SET status = @status, " +
            "updated_at = CURRENT_TIMESTAMP WHERE run_id = @runId " +
            "AND token_id = @tokenId AND extension_key = @extensionKey " +
            "AND status = @pendingStatus",
    );
    private selectPendingTaskCountStmt = db.prepare<{
        runId: string;
        pendingStatus: string;
    }>(
        "SELECT COUNT(*) AS count FROM metadata_refresh_extension_artifact_tasks " +
            "WHERE run_id = @runId AND status = @pendingStatus",
    );

    constructor(private readonly queueOutbox: SqliteQueueOutbox) {}

    createRunWithExtensionArtifactTasks(input: {
        run: MetadataRefreshFollowupRunInput;
        tasks: readonly MetadataRefreshExtensionArtifactTaskSeed[];
        extensionArtifactJobs: readonly JobEnvelope<CollectionExtensionRefreshArtifactsPayload>[];
    }): void {
        const persist = db.raw.transaction(() => {
            this.insertRun(input.run);
            if (this.isRunFinalized(input.run.runId)) {
                return;
            }
            for (const task of input.tasks) {
                this.insertTaskStmt.run({
                    runId: input.run.runId,
                    ...task,
                    pendingStatus:
                        METADATA_REFRESH_EXTENSION_ARTIFACT_TASK_STATUS.Pending,
                });
            }
            for (const job of input.extensionArtifactJobs) {
                this.queueOutbox.enqueueJob(job);
            }
        });
        persist();
    }

    enqueueFinalStatsOnce(input: {
        run: MetadataRefreshFollowupRunInput;
    }): boolean {
        const persist = db.raw.transaction(() => {
            this.insertRun(input.run);
            return this.finalizeRunAndEnqueueStats(input.run.runId);
        });
        return persist() as boolean;
    }

    markExtensionArtifactTaskTerminal(input: {
        runId: string;
        tokenId: string;
        extensionKey: CollectionExtensionKey;
        status: MetadataRefreshExtensionArtifactTerminalStatus;
    }): boolean {
        const persist = db.raw.transaction(() => {
            this.markTaskTerminalStmt.run({
                runId: input.runId,
                tokenId: input.tokenId,
                extensionKey: input.extensionKey,
                status: input.status,
                pendingStatus:
                    METADATA_REFRESH_EXTENSION_ARTIFACT_TASK_STATUS.Pending,
            });
            if (this.countPendingTasks(input.runId) > 0) {
                return false;
            }
            return this.finalizeRunAndEnqueueStats(input.runId);
        });
        return persist() as boolean;
    }

    private insertRun(input: MetadataRefreshFollowupRunInput): void {
        this.insertRunStmt.run({
            runId: input.runId,
            chainId: input.chainId,
            collectionId: input.collectionId,
            reason: input.reason,
            sourceJobId: input.sourceJobId,
            traceId: input.traceId,
            statsJobJson: JSON.stringify(input.statsJob),
            status: METADATA_REFRESH_RUN_STATUS.Pending,
        });
    }

    private isRunFinalized(runId: string): boolean {
        const row = this.selectRunStatusStmt.get({
            runId,
        }) as MetadataRefreshRunStatusRow | undefined;
        return row?.status === METADATA_REFRESH_RUN_STATUS.Finalized;
    }

    private countPendingTasks(runId: string): number {
        const row = this.selectPendingTaskCountStmt.get({
            runId,
            pendingStatus:
                METADATA_REFRESH_EXTENSION_ARTIFACT_TASK_STATUS.Pending,
        }) as PendingTaskCountRow | undefined;
        return row?.count ?? 0;
    }

    private finalizeRunAndEnqueueStats(runId: string): boolean {
        if (this.isRunFinalized(runId)) {
            return false;
        }
        const row = this.selectRunStatsJobStmt.get({
            runId,
        }) as MetadataRefreshRunStatsJobRow | undefined;
        if (!row) {
            throw new Error("Metadata refresh run missing final stats job");
        }
        const statsJob = JSON.parse(
            row.stats_job_json,
        ) as JobEnvelope<MetadataStatsRecomputePayload>;
        const outboxId = this.queueOutbox.enqueueJob(statsJob);
        const result = this.finalizeRunStmt.run({
            runId,
            finalizedStatus: METADATA_REFRESH_RUN_STATUS.Finalized,
            statsQueueOutboxId: outboxId,
            pendingStatus: METADATA_REFRESH_RUN_STATUS.Pending,
        });
        return result.changes > 0;
    }
}
