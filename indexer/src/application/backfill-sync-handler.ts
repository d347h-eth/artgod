import { logger } from "@artgod/shared/utils";
import type { JobEnvelope } from "../domain/jobs.js";
import {
    BACKFILL_SOURCE,
    SYNC_JOB_KIND,
    decodeBackfillSyncJob,
} from "../domain/sync-jobs.js";
import { SYNC_WORK_COMPLETION } from "../domain/sync-work.js";
import type { RpcProviderPort } from "../ports/rpc.js";
import type { StoragePort } from "../ports/storage.js";
import type { SyncRangeCommitPort } from "../ports/sync-range-commit.js";
import type {
    CollectionRegistryPort,
    CollectionScopeResolverPort,
} from "../ports/collections.js";
import type { CollectionExtensionInstallPort } from "../ports/collection-extensions.js";
import type { BidderIndex } from "./bidder-index.js";
import {
    BackfillExecutionGate,
    resolveBackfillExecutionMode,
} from "./backfill-execution.js";
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
    storage: StoragePort;
    commit: SyncRangeCommitPort;
    collectionsPort: Pick<
        CollectionRegistryPort,
        "getCollection" | "listCollectionsForSync"
    > &
        CollectionScopeResolverPort;
    extensions: Pick<CollectionExtensionInstallPort, "getInstall">;
    bidderIndex: Pick<BidderIndex, "isActive" | "shouldEmit">;
    gate: Pick<BackfillExecutionGate, "run">;
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
        const executionMode = resolveBackfillExecutionMode(collections, range);
        await input.gate.run(executionMode, async () => {
            const { data, blocks } = await processSyncRange({
                rpc: input.rpc,
                storage: input.storage,
                commit: input.commit,
                collectionScopeResolver: input.collectionsPort,
                collectionExtensions: input.extensions,
                chainId: input.chainId,
                collections,
                range,
                bidderIndex: input.bidderIndex,
                wethAddress: input.wethAddress,
                orderMaintenancePolicy: job.payload.orderMaintenancePolicy,
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
                backfillExecutionMode: executionMode,
                backfillWorkerCount: input.workerCount,
                blocks: blocks.length,
                transfers: data.collectionScoped.nftTransferEvents.length,
                nftApprovals: data.collectionScoped.nftApprovalEvents.length,
                balanceDeltas: data.collectionScoped.nftBalanceDeltas.length,
            });
        });
    };
}
