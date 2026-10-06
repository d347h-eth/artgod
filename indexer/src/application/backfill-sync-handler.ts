import { logger } from "@artgod/shared/utils";
import type { JobEnvelope } from "../domain/jobs.js";
import {
    BACKFILL_SOURCE,
    SYNC_JOB_KIND,
    decodeBackfillSyncJob,
} from "../domain/sync-jobs.js";
import type { DomainSyncSource } from "../domain/domain-jobs.js";
import type { CollectionRecord } from "../domain/collections.js";
import type { RpcProviderPort } from "../ports/rpc.js";
import type { StoragePort } from "../ports/storage.js";
import type { QueuePort } from "../ports/queue.js";
import type {
    CollectionRegistryPort,
    CollectionScopeResolverPort,
} from "../ports/collections.js";
import type { CollectionExtensionInstallPort } from "../ports/collection-extensions.js";
import type { BidderIndex } from "./bidder-index.js";
import type { SyncRange } from "./sync.js";
import {
    BackfillExecutionGate,
    resolveBackfillExecutionMode,
} from "./backfill-execution.js";
import {
    domainSyncSource,
    processRange,
    publishDomainJobs,
    resolveBackfillCollections,
} from "./sync-range-processing.js";
import {
    executeSyncGapRepair,
    resolveCurrentSyncGapRepairs,
    type SyncGapStorePort,
} from "./sync-gap-scheduler.js";
import { executeReorgResync } from "./reorg-recovery.js";

export const SYNC_WORKER_LOG_COMPONENT = "IndexerSyncWorker";
const BACKFILL_SYNC_LOG_ACTION = "backfillRange";

// The runtime and broker regressions use this same handler. Decode the queue
// contract before collection selection; durable owners still fence execution.
export function createBackfillSyncHandler(input: {
    chainId: number;
    batchSize: number;
    workerCount: number;
    wethAddress: string;
    rpc: RpcProviderPort;
    storage: StoragePort;
    collectionsPort: Pick<
        CollectionRegistryPort,
        "getCollection" | "listCollectionsForSync"
    > &
        CollectionScopeResolverPort;
    extensions: Pick<CollectionExtensionInstallPort, "getInstall">;
    queue: Pick<QueuePort, "publish">;
    bidderIndex: Pick<BidderIndex, "isActive" | "shouldEmit">;
    gaps: Pick<SyncGapStorePort, "getProgress" | "recordRepairProgress">;
    recoveries: Parameters<typeof executeReorgResync>[1];
    gate: Pick<BackfillExecutionGate, "run">;
    now?: () => number;
}): (job: JobEnvelope) => Promise<void> {
    const {
        chainId,
        batchSize,
        workerCount,
        wethAddress,
        rpc,
        storage,
        collectionsPort,
        extensions,
        queue,
        bidderIndex,
        gaps,
        recoveries,
        gate,
        now = Date.now,
    } = input;
    return async (incoming: JobEnvelope) => {
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
        if (job.chainId !== chainId) return;
        const isGapRepair = job.payload.source === BACKFILL_SOURCE.GapRepair;
        const isReorgRecovery =
            job.payload.source === BACKFILL_SOURCE.ReorgRecovery;
        // Explicit batch members (or a retained legacy scoped intent)
        // determine admission; an unowned hint cannot select all collections.
        const collections = isGapRepair
            ? resolveCurrentSyncGapRepairs(job, collectionsPort, gaps).map(
                  (target) => target.collection,
              )
            : resolveBackfillCollections(
                  collectionsPort,
                  chainId,
                  job.collectionId ?? null,
              );
        if (collections.length === 0) {
            logger.debug("No collections for backfill sync", {
                component: SYNC_WORKER_LOG_COMPONENT,
                action: BACKFILL_SYNC_LOG_ACTION,
                fromBlock: job.payload.fromBlock,
                toBlock: job.payload.toBlock,
                collectionId: job.collectionId ?? null,
            });
            return;
        }
        const range: SyncRange = {
            fromBlock: job.payload.fromBlock,
            toBlock: job.payload.toBlock,
        };
        const orderMaintenancePolicy = job.payload.orderMaintenancePolicy;
        const executionMode = resolveBackfillExecutionMode(collections, range);
        await gate.run(executionMode, async () => {
            const syncAndPublish = async (
                collections: CollectionRecord[],
                sources: DomainSyncSource[],
            ) => {
                const { data, blocks } = await processRange({
                    rpc,
                    storage,
                    collectionScopeResolver: collectionsPort,
                    collectionExtensions: extensions,
                    chainId,
                    collections,
                    range,
                    bidderIndex,
                    wethAddress,
                    orderMaintenancePolicy,
                });
                await publishDomainJobs(
                    queue,
                    chainId,
                    collections,
                    range,
                    sources,
                    "backfill",
                    data,
                    orderMaintenancePolicy,
                );
                logger.info("Backfill range processed", {
                    component: SYNC_WORKER_LOG_COMPONENT,
                    action: BACKFILL_SYNC_LOG_ACTION,
                    fromBlock: job.payload.fromBlock,
                    toBlock: job.payload.toBlock,
                    source: job.payload.source,
                    orderMaintenancePolicy,
                    collectionIds: collections.map(
                        (collection) => collection.id,
                    ),
                    backfillExecutionMode: executionMode,
                    backfillWorkerCount: workerCount,
                    blocks: blocks.length,
                    transfers: data.collectionScoped.nftTransferEvents.length,
                    nftApprovals:
                        data.collectionScoped.nftApprovalEvents.length,
                    balanceDeltas:
                        data.collectionScoped.nftBalanceDeltas.length,
                });
            };
            if (isGapRepair) {
                await executeSyncGapRepair(
                    job,
                    collectionsPort,
                    gaps,
                    syncAndPublish,
                    now,
                );
            } else if (isReorgRecovery) {
                // Reload after gate admission. An empty eligible set does
                // not complete recovery; its durable range remains pending.
                const currentCollections = resolveBackfillCollections(
                    collectionsPort,
                    chainId,
                    job.collectionId ?? null,
                );
                if (!currentCollections.length) return;
                await executeReorgResync(
                    job,
                    recoveries,
                    { batchSize, now },
                    () =>
                        syncAndPublish(currentCollections, [
                            domainSyncSource(job),
                        ]),
                );
            } else {
                await syncAndPublish(collections, [domainSyncSource(job)]);
            }
        });
    };
}
