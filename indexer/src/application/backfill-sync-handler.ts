import { logger } from "@artgod/shared/utils";
import type { JobEnvelope } from "../domain/jobs.js";
import {
    BACKFILL_SOURCE,
    SYNC_JOB_KIND,
    decodeBackfillSyncJob,
} from "../domain/sync-jobs.js";
import {
    SYNC_APPLICATION_KIND,
    SYNC_WORK_COMPLETION,
} from "../domain/sync-work.js";
import type { RpcProviderPort } from "../ports/rpc.js";
import type { StoragePort } from "../ports/storage.js";
import type { SyncRangeCommitPort } from "../ports/sync-range-commit.js";
import type { CanonicalChecksPort } from "../ports/canonical-checks.js";
import type {
    CollectionRegistryPort,
    CollectionScopeResolverPort,
} from "../ports/collections.js";
import type { CollectionExtensionInstallPort } from "../ports/collection-extensions.js";
import {
    domainSyncSource,
    processSyncRange,
    resolveBackfillCollections,
} from "./sync-range-processing.js";

export const SYNC_WORKER_LOG_COMPONENT = "IndexerSyncWorker";
const BACKFILL_SYNC_LOG_ACTION = "backfillRange";

// Broker ranges now serve manual and bootstrap requests. Old automatic hints
// are acknowledged without acquisition: their retained SQLite owner is executed
// by AutomaticSyncExecutor, including work pending when the app was upgraded.
export function createBackfillSyncHandler(input: {
    chainId: number;
    workerCount: number;
    wethAddress: string;
    rpc: RpcProviderPort;
    reorgDepth: number;
    storage: StoragePort;
    commit: SyncRangeCommitPort;
    canonicalChecks: Pick<CanonicalChecksPort, "retain">;
    collectionsPort: Pick<
        CollectionRegistryPort,
        "getCollection" | "listCollectionsForSync"
    > &
        CollectionScopeResolverPort;
    extensions: Pick<CollectionExtensionInstallPort, "getInstall">;
    wakeCurrentSync(): void;
}): (job: JobEnvelope) => Promise<void> {
    return async (incoming) => {
        if (incoming.kind !== SYNC_JOB_KIND.BackfillRange) return;
        const job = decodeBackfillSyncJob(incoming);
        if (!job) {
            logger.warn("Invalid backfill sync job", {
                component: SYNC_WORKER_LOG_COMPONENT,
                action: BACKFILL_SYNC_LOG_ACTION,
                jobId: incoming.jobId,
            });
            return;
        }
        if (
            job.chainId !== input.chainId ||
            job.payload.source === BACKFILL_SOURCE.GapRepair ||
            job.payload.source === BACKFILL_SOURCE.ReorgRecovery
        )
            return;
        if (job.payload.source === BACKFILL_SOURCE.BootstrapCatchup) {
            // The installed base and sampled target already retain this work.
            // A broker hint never grants permission to apply out of order.
            input.wakeCurrentSync();
            return;
        }
        const collections = resolveBackfillCollections(
            input.collectionsPort,
            input.chainId,
            job.collectionId ?? null,
        );
        if (!collections.length) return;
        const range = {
            fromBlock: job.payload.fromBlock,
            toBlock: job.payload.toBlock,
        };
        const { data, blocks } = await processSyncRange({
            rpc: input.rpc,
            storage: input.storage,
            commit: input.commit,
            canonicalChecks: input.canonicalChecks,
            collectionScopeResolver: input.collectionsPort,
            collectionExtensions: input.extensions,
            chainId: input.chainId,
            reorgDepth: input.reorgDepth,
            collections,
            range,
            application: { kind: SYNC_APPLICATION_KIND.Historical },
            wethAddress: input.wethAddress,
            sources: [domainSyncSource(job)],
            mode: "backfill",
            completion: { kind: SYNC_WORK_COMPLETION.Unmanaged },
        });
        logger.info("Backfill range acquired", {
            component: SYNC_WORKER_LOG_COMPONENT,
            action: BACKFILL_SYNC_LOG_ACTION,
            ...range,
            source: job.payload.source,
            orderMaintenancePolicy: job.payload.orderMaintenancePolicy,
            collectionIds: collections.map((collection) => collection.id),
            backfillWorkerCount: input.workerCount,
            blocks: blocks.length,
            transfers: data.collectionScoped.nftTransferEvents.length,
            nftApprovals: data.collectionScoped.nftApprovalEvents.length,
            balanceDeltas: data.collectionScoped.nftBalanceDeltas.length,
        });
    };
}
