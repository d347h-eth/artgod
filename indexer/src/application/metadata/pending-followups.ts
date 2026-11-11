import { SYNC_WORK_CLASS } from "@artgod/shared/types/sync-work-class";
import {
    METADATA_REFRESH_REASON,
    METADATA_REFRESH_SOURCE,
    METADATA_STATS_RECOMPUTE_REASON,
} from "../../domain/domain-jobs.js";
import { METADATA_REFRESH_RUN_ID_SCOPE } from "../../domain/metadata-refresh-followups.js";
import type { MetadataAttempt } from "../../domain/metadata-pending.js";
import type { MetadataUpdatedToken } from "../../domain/metadata.js";
import type { JobEnvelope } from "../../domain/jobs.js";
import type { CollectionExtensionInstallPort } from "../../ports/collection-extensions.js";
import {
    enqueueMetadataRefreshFollowups,
    type MetadataRefreshFollowupStoragePort,
} from "./refresh-followups.js";
import {
    buildMetadataImageRefreshes,
    type MetadataImageCachePolicyPort,
} from "./image-refresh.js";

/** Synchronous retained effects join the canonical write and removal of pending intent. */
export function createMetadataPendingFollowups(input: {
    chainId: number;
    followups: MetadataRefreshFollowupStoragePort;
    extensions: Pick<CollectionExtensionInstallPort, "getInstall">;
    imagePolicy: MetadataImageCachePolicyPort;
    outbox: { enqueueJob<T>(job: JobEnvelope<T>): number };
}): (updated: MetadataUpdatedToken, attempt: MetadataAttempt) => void {
    return (updated, attempt) => {
        enqueueMetadataRefreshFollowups({
            followups: input.followups,
            collectionExtensions: input.extensions,
            chainId: input.chainId,
            updatedTokens: [updated],
            runScope: METADATA_REFRESH_RUN_ID_SCOPE.MetadataPending,
            artifactReason: METADATA_REFRESH_REASON.Pending,
            statsReason: METADATA_STATS_RECOMPUTE_REASON.MetadataRefresh,
            sourceJobId: attempt.owner,
            traceId: attempt.owner,
            workClass: SYNC_WORK_CLASS.GapRepair,
            source: METADATA_REFRESH_SOURCE.Onchain,
        });
        for (const job of buildMetadataImageRefreshes({
            policy: input.imagePolicy,
            chainId: input.chainId,
            updatedTokens: [updated],
            traceId: attempt.owner,
            workClass: SYNC_WORK_CLASS.GapRepair,
            source: METADATA_REFRESH_SOURCE.Onchain,
        }))
            input.outbox.enqueueJob(job);
    };
}
