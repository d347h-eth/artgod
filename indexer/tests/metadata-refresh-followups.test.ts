import { beforeEach, describe, expect, it } from "vitest";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { db, setDbPath } from "@artgod/shared/database";
import { createMigrationRunner } from "@artgod/shared/migrations";
import { TERRAFORMS_EXTENSION_KEY } from "@artgod/shared/extensions/terraforms";
import { buildCollectionExtensionRefreshArtifactsJob } from "../src/application/collection-extensions/jobs.js";
import {
    buildBootstrapFinalStatsFollowupRun,
    buildBootstrapMetadataSnapshotStatsFollowupRun,
    buildFollowupRun,
} from "../src/application/metadata/refresh-followups.js";
import {
    DOMAIN_JOB_KIND,
    METADATA_STATS_RECOMPUTE_REASON,
    type MetadataStatsRecomputePayload,
} from "../src/domain/domain-jobs.js";
import {
    METADATA_REFRESH_EXTENSION_ARTIFACT_TASK_STATUS,
    METADATA_REFRESH_RUN_ID_SCOPE,
    METADATA_REFRESH_RUN_STATUS,
} from "../src/domain/metadata-refresh-followups.js";
import { QUEUE_NAMES } from "../src/domain/queues.js";
import { SqliteMetadataRefreshFollowups } from "../src/infra/metadata/sqlite-refresh-followups.js";
import { SqliteQueueOutbox } from "../src/infra/queue/sqlite-queue-outbox.js";

const CHAIN_ID = 1;
const COLLECTION_ID = 7;
const BOOTSTRAP_RUN_ID = 41;
const CONTRACT_ADDRESS = "0xabc0000000000000000000000000000000000000";
const TRACE_ID = "metadata-refresh-followups-test-trace";
const SOURCE_JOB_ID = "metadata-refresh-followups-test-job";

describe("SqliteMetadataRefreshFollowups", () => {
    beforeEach(async () => {
        setDbPath(await createTempDbPath());
        await createMigrationRunner().runMigrations();
    });

    it("finalizes once after every extension artifact task is terminal", () => {
        const queueOutbox = new SqliteQueueOutbox();
        const followups = new SqliteMetadataRefreshFollowups(queueOutbox);
        const run = buildFollowupRun({
            chainId: CHAIN_ID,
            collectionId: COLLECTION_ID,
            runScope: METADATA_REFRESH_RUN_ID_SCOPE.MetadataRefresh,
            statsReason: METADATA_STATS_RECOMPUTE_REASON.MetadataRefresh,
            sourceJobId: SOURCE_JOB_ID,
            traceId: TRACE_ID,
        });

        followups.createRunWithExtensionArtifactTasks({
            run,
            tasks: ["1", "2"].map((tokenId) => ({
                chainId: CHAIN_ID,
                collectionId: COLLECTION_ID,
                contract: CONTRACT_ADDRESS,
                tokenId,
                extensionKey: TERRAFORMS_EXTENSION_KEY,
            })),
            extensionArtifactJobs: ["1", "2"].map((tokenId) =>
                buildCollectionExtensionRefreshArtifactsJob(
                    {
                        chainId: CHAIN_ID,
                        collectionId: COLLECTION_ID,
                        contract: CONTRACT_ADDRESS,
                        tokenId,
                        reason: METADATA_STATS_RECOMPUTE_REASON.MetadataRefresh,
                        metadataRefreshRunId: run.runId,
                        metadataRefreshExtensionKey: TERRAFORMS_EXTENSION_KEY,
                    },
                    TRACE_ID,
                ),
            ),
        });

        expect(countOutboxRows(QUEUE_NAMES.CollectionExtensionArtifacts)).toBe(
            2,
        );
        expect(countOutboxRows(QUEUE_NAMES.MetadataStats)).toBe(0);

        const firstFinalized = followups.markExtensionArtifactTaskTerminal({
            runId: run.runId,
            tokenId: "1",
            extensionKey: TERRAFORMS_EXTENSION_KEY,
            status: METADATA_REFRESH_EXTENSION_ARTIFACT_TASK_STATUS.Succeeded,
        });
        expect(firstFinalized).toBe(false);
        expect(countOutboxRows(QUEUE_NAMES.MetadataStats)).toBe(0);

        const secondFinalized = followups.markExtensionArtifactTaskTerminal({
            runId: run.runId,
            tokenId: "2",
            extensionKey: TERRAFORMS_EXTENSION_KEY,
            status: METADATA_REFRESH_EXTENSION_ARTIFACT_TASK_STATUS.Skipped,
        });
        expect(secondFinalized).toBe(true);
        expect(countOutboxRows(QUEUE_NAMES.MetadataStats)).toBe(1);
        expect(selectRunStatus(run.runId)).toBe(
            METADATA_REFRESH_RUN_STATUS.Finalized,
        );

        const duplicateFinalized = followups.markExtensionArtifactTaskTerminal({
            runId: run.runId,
            tokenId: "2",
            extensionKey: TERRAFORMS_EXTENSION_KEY,
            status: METADATA_REFRESH_EXTENSION_ARTIFACT_TASK_STATUS.Skipped,
        });
        expect(duplicateFinalized).toBe(false);
        expect(countOutboxRows(QUEUE_NAMES.MetadataStats)).toBe(1);
        expect(selectMetadataStatsJobKind()).toBe(
            DOMAIN_JOB_KIND.MetadataStatsRecompute,
        );
    });

    it("enqueues final stats once when no extension artifact task is required", () => {
        const queueOutbox = new SqliteQueueOutbox();
        const followups = new SqliteMetadataRefreshFollowups(queueOutbox);
        const run = buildFollowupRun({
            chainId: CHAIN_ID,
            collectionId: COLLECTION_ID,
            runScope: METADATA_REFRESH_RUN_ID_SCOPE.MetadataSync,
            statsReason: METADATA_STATS_RECOMPUTE_REASON.MetadataSync,
            sourceJobId: SOURCE_JOB_ID,
            traceId: TRACE_ID,
        });

        expect(followups.enqueueFinalStatsOnce({ run })).toBe(true);
        expect(followups.enqueueFinalStatsOnce({ run })).toBe(false);
        expect(countOutboxRows(QUEUE_NAMES.MetadataStats)).toBe(1);
    });

    it("keeps bootstrap metadata-snapshot and final stats checkpoints separate", () => {
        const queueOutbox = new SqliteQueueOutbox();
        const followups = new SqliteMetadataRefreshFollowups(queueOutbox);
        const metadataSnapshotRun =
            buildBootstrapMetadataSnapshotStatsFollowupRun({
                bootstrapRunId: BOOTSTRAP_RUN_ID,
                chainId: CHAIN_ID,
                collectionId: COLLECTION_ID,
                sourceJobId: SOURCE_JOB_ID,
                traceId: TRACE_ID,
            });
        const finalRun = buildBootstrapFinalStatsFollowupRun({
            bootstrapRunId: BOOTSTRAP_RUN_ID,
            chainId: CHAIN_ID,
            collectionId: COLLECTION_ID,
            statsReason: METADATA_STATS_RECOMPUTE_REASON.BootstrapFinalized,
            sourceJobId: SOURCE_JOB_ID,
            traceId: TRACE_ID,
        });

        expect(metadataSnapshotRun.runId).not.toBe(finalRun.runId);
        expect(followups.enqueueFinalStatsOnce({ run: metadataSnapshotRun })).toBe(
            true,
        );
        expect(followups.enqueueFinalStatsOnce({ run: metadataSnapshotRun })).toBe(
            false,
        );
        expect(followups.enqueueFinalStatsOnce({ run: finalRun })).toBe(true);
        expect(followups.enqueueFinalStatsOnce({ run: finalRun })).toBe(false);

        expect(countOutboxRows(QUEUE_NAMES.MetadataStats)).toBe(2);
        expect(selectMetadataStatsJobPayloadReasons()).toEqual([
            METADATA_STATS_RECOMPUTE_REASON.BootstrapMetadataSnapshot,
            METADATA_STATS_RECOMPUTE_REASON.BootstrapFinalized,
        ]);
    });
});

async function createTempDbPath(): Promise<string> {
    const dir = await mkdtemp(join(tmpdir(), "artgod-refresh-followups-"));
    return join(dir, "main.sqlite");
}

function countOutboxRows(queueName: string): number {
    const row = db
        .prepare<
            [string]
        >("SELECT COUNT(1) AS count FROM queue_outbox WHERE queue_name = ?")
        .get(queueName) as { count: number } | undefined;
    return row?.count ?? 0;
}

function selectRunStatus(runId: string): string | null {
    const row = db
        .prepare<
            [string]
        >("SELECT status FROM metadata_refresh_runs WHERE run_id = ?")
        .get(runId) as { status: string } | undefined;
    return row?.status ?? null;
}

function selectMetadataStatsJobKind(): string | null {
    const row = db
        .prepare<
            [string]
        >("SELECT job_json FROM queue_outbox WHERE queue_name = ? LIMIT 1")
        .get(QUEUE_NAMES.MetadataStats) as { job_json: string } | undefined;
    return row ? JSON.parse(row.job_json).kind : null;
}

function selectMetadataStatsJobPayloadReasons(): string[] {
    const rows = db
        .prepare<
            [string]
        >("SELECT job_json FROM queue_outbox WHERE queue_name = ? ORDER BY outbox_id ASC")
        .all(QUEUE_NAMES.MetadataStats) as { job_json: string }[];
    return rows.map((row) => {
        const job = JSON.parse(row.job_json) as {
            payload: MetadataStatsRecomputePayload;
        };
        return job.payload.reason;
    });
}
