import type { CollectionExtensionKey } from "@artgod/shared/extensions";
import { buildCollectionExtensionRefreshArtifactsJob } from "../collection-extensions/jobs.js";
import { buildMetadataStatsRecomputeJob } from "./stats-recompute.js";
import type { MetadataUpdatedToken } from "../../domain/metadata.js";
import {
    METADATA_REFRESH_RUN_ID_SCOPE,
    buildMetadataRefreshRunId,
    type MetadataRefreshRunIdScope,
} from "../../domain/metadata-refresh-followups.js";
import type {
    MetadataStatsRecomputePayload,
    MetadataStatsRecomputeReason,
} from "../../domain/domain-jobs.js";
import type { JobEnvelope } from "../../domain/jobs.js";
import type { CollectionExtensionInstallPort } from "../../ports/collection-extensions.js";
import type { CollectionExtensionRefreshArtifactsPayload } from "../../domain/collection-extension-jobs.js";

// MetadataRefreshExtensionArtifactTaskSeed stores one extension job dependency.
export type MetadataRefreshExtensionArtifactTaskSeed = {
    chainId: number;
    collectionId: number;
    contract: string;
    tokenId: string;
    extensionKey: CollectionExtensionKey;
};

// MetadataRefreshFollowupRunInput is the durable guard for final stats release.
export type MetadataRefreshFollowupRunInput = {
    runId: string;
    chainId: number;
    collectionId: number;
    reason: string;
    sourceJobId: string;
    traceId: string;
    statsJob: JobEnvelope<MetadataStatsRecomputePayload>;
};

// MetadataRefreshFollowupStoragePort persists guarded post-metadata work.
export interface MetadataRefreshFollowupStoragePort {
    createRunWithExtensionArtifactTasks(input: {
        run: MetadataRefreshFollowupRunInput;
        tasks: readonly MetadataRefreshExtensionArtifactTaskSeed[];
        extensionArtifactJobs: readonly JobEnvelope<CollectionExtensionRefreshArtifactsPayload>[];
    }): void;
    enqueueFinalStatsOnce(input: {
        run: MetadataRefreshFollowupRunInput;
    }): boolean;
}

// MetadataRefreshFollowupInput describes one successful metadata-write batch.
export type MetadataRefreshFollowupInput = {
    followups: MetadataRefreshFollowupStoragePort;
    collectionExtensions: CollectionExtensionInstallPort;
    chainId: number;
    updatedTokens: readonly MetadataUpdatedToken[];
    runScope: MetadataRefreshRunIdScope;
    artifactReason: string;
    statsReason: MetadataStatsRecomputeReason;
    sourceJobId: string;
    traceId: string;
    source?: string | null;
};

// Persists post-metadata work needed before one collection stats recompute.
export function enqueueMetadataRefreshFollowups(
    input: MetadataRefreshFollowupInput,
): void {
    const tokensByCollection = groupUpdatedTokensByCollection(
        input.updatedTokens,
    );
    for (const [collectionId, tokens] of tokensByCollection) {
        const run = buildFollowupRun({
            chainId: input.chainId,
            collectionId,
            runScope: input.runScope,
            statsReason: input.statsReason,
            sourceJobId: input.sourceJobId,
            traceId: input.traceId,
        });
        const install = input.collectionExtensions.getInstall(
            input.chainId,
            collectionId,
        );
        if (!install?.enabled) {
            input.followups.enqueueFinalStatsOnce({ run });
            continue;
        }

        const tasks: MetadataRefreshExtensionArtifactTaskSeed[] = [];
        const extensionArtifactJobs: JobEnvelope<CollectionExtensionRefreshArtifactsPayload>[] =
            [];
        for (const token of tokens.values()) {
            tasks.push({
                chainId: input.chainId,
                collectionId,
                contract: token.contract,
                tokenId: token.tokenId,
                extensionKey: install.extensionKey,
            });
            extensionArtifactJobs.push(
                buildCollectionExtensionRefreshArtifactsJob(
                    {
                        chainId: input.chainId,
                        collectionId,
                        contract: token.contract,
                        tokenId: token.tokenId,
                        reason: input.artifactReason,
                        source: input.source,
                        metadataRefreshRunId: run.runId,
                        metadataRefreshExtensionKey: install.extensionKey,
                    },
                    input.traceId,
                ),
            );
        }
        input.followups.createRunWithExtensionArtifactTasks({
            run,
            tasks,
            extensionArtifactJobs,
        });
    }
}

// Builds the one stats job guarded by this refresh follow-up run.
export function buildFollowupRun(input: {
    chainId: number;
    collectionId: number;
    runScope: MetadataRefreshRunIdScope;
    statsReason: MetadataStatsRecomputeReason;
    sourceJobId: string;
    traceId: string;
}): MetadataRefreshFollowupRunInput {
    const statsPayload: MetadataStatsRecomputePayload = {
        chainId: input.chainId,
        collectionId: input.collectionId,
        reason: input.statsReason,
        sourceJobId: input.sourceJobId,
    };
    return {
        runId: buildMetadataRefreshRunId({
            scope: input.runScope,
            chainId: input.chainId,
            collectionId: input.collectionId,
            sourceJobId: input.sourceJobId,
        }),
        chainId: input.chainId,
        collectionId: input.collectionId,
        reason: input.statsReason,
        sourceJobId: input.sourceJobId,
        traceId: input.traceId,
        statsJob: buildMetadataStatsRecomputeJob(statsPayload, input.traceId),
    };
}

// Builds the durable final-stats guard for one bootstrap run.
export function buildBootstrapFinalStatsFollowupRun(input: {
    bootstrapRunId: number;
    chainId: number;
    collectionId: number;
    statsReason: MetadataStatsRecomputeReason;
    sourceJobId: string;
    traceId: string;
}): MetadataRefreshFollowupRunInput {
    const statsPayload: MetadataStatsRecomputePayload = {
        chainId: input.chainId,
        collectionId: input.collectionId,
        reason: input.statsReason,
        sourceJobId: input.sourceJobId,
    };
    return {
        runId: buildMetadataRefreshRunId({
            scope: METADATA_REFRESH_RUN_ID_SCOPE.Bootstrap,
            chainId: input.chainId,
            collectionId: input.collectionId,
            sourceJobId: input.bootstrapRunId.toString(),
        }),
        chainId: input.chainId,
        collectionId: input.collectionId,
        reason: input.statsReason,
        sourceJobId: input.sourceJobId,
        traceId: input.traceId,
        statsJob: buildMetadataStatsRecomputeJob(statsPayload, input.traceId),
    };
}

function groupUpdatedTokensByCollection(
    updatedTokens: readonly MetadataUpdatedToken[],
): Map<number, Map<string, MetadataUpdatedToken>> {
    const groups = new Map<number, Map<string, MetadataUpdatedToken>>();
    for (const token of updatedTokens) {
        let tokens = groups.get(token.collectionId);
        if (!tokens) {
            tokens = new Map<string, MetadataUpdatedToken>();
            groups.set(token.collectionId, tokens);
        }
        tokens.set(token.tokenId, token);
    }
    return groups;
}
