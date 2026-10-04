import { syncRange, type SyncRange } from "./sync.js";
import { COLLECTION_STATUS } from "@artgod/shared/types";
import { fetchCanonicalSyncBlocks } from "./sync-blocks.js";
import { resolveIndexerCollectionExtension } from "./collection-extensions/index.js";
import type { CollectionExtensionSyncWatchSpec } from "./collection-extensions/types.js";
import type { BidderIndex } from "./bidder-index.js";
import { decodeWethMakerInfos, WETH_EVENT_FILTERS } from "./ft/weth.js";
import { shouldFetchWethMakerLogs } from "./backfill-order-maintenance.js";
import {
    canAnyCollectionProjectCurrentStateAt,
    publishOrderUpdateJobs,
} from "./order-update-fanout.js";
import type { JobEnvelope } from "../domain/jobs.js";
import { QUEUE_NAMES } from "../domain/queues.js";
import {
    DOMAIN_JOB_KIND,
    DOMAIN_SYNC_PROJECTION,
    type DomainSyncMode,
    type DomainSyncPayload,
    type MetadataRefreshPayload,
    type MetadataRefreshRangePayload,
} from "../domain/domain-jobs.js";
import type { OnChainData } from "../domain/onchain.js";
import type { BackfillOrderMaintenancePolicy } from "../domain/sync-jobs.js";
import type { CollectionRecord } from "../domain/collections.js";
import type { Hex, RpcBlock, RpcProviderPort } from "../ports/rpc.js";
import type { StoragePort } from "../ports/storage.js";
import type { QueuePort } from "../ports/queue.js";
import type {
    CollectionRegistryPort,
    CollectionScopeResolverPort,
} from "../ports/collections.js";
import type { CollectionExtensionInstallPort } from "../ports/collection-extensions.js";

export async function processRange(input: {
    rpc: RpcProviderPort;
    storage: StoragePort;
    collectionScopeResolver: CollectionScopeResolverPort;
    collectionExtensions: Pick<CollectionExtensionInstallPort, "getInstall">;
    chainId: number;
    collections: CollectionRecord[];
    range: SyncRange;
    bidderIndex: Pick<BidderIndex, "isActive" | "shouldEmit">;
    wethAddress: string;
    orderMaintenancePolicy: BackfillOrderMaintenancePolicy;
}): Promise<{ data: OnChainData; blocks: RpcBlock[] }> {
    const {
        rpc,
        storage,
        collectionScopeResolver,
        collectionExtensions,
        chainId,
        collections,
        range,
        bidderIndex,
        wethAddress,
        orderMaintenancePolicy,
    } = input;
    const checkpoint = storage.captureSyncCheckpoint(chainId);
    const extensionWatchSpecs = resolveCollectionExtensionWatchSpecs(
        collectionExtensions,
        chainId,
        collections,
    );
    const data = await syncRange(
        rpc,
        chainId,
        collections,
        collectionScopeResolver,
        range,
        extensionWatchSpecs,
    );
    await appendWethMakerInfos(
        rpc,
        range,
        wethAddress,
        bidderIndex,
        data,
        collections,
        orderMaintenancePolicy,
    );
    const blocks = await fetchCanonicalSyncBlocks({ rpc, ...range });
    storage.persistSyncResult({ checkpoint, blocks, data, collections });
    return { data, blocks };
}

export async function publishDomainJobs<TPayload>(
    queue: QueuePort,
    chainId: number,
    collections: CollectionRecord[],
    range: SyncRange,
    job: JobEnvelope<TPayload>,
    mode: DomainSyncMode,
    data: OnChainData,
    orderMaintenancePolicy: BackfillOrderMaintenancePolicy,
): Promise<void> {
    // Build the current-state sync payload for this range.
    const currentStatePayload: DomainSyncPayload = {
        fromBlock: range.fromBlock,
        toBlock: range.toBlock,
        mode,
        projection: DOMAIN_SYNC_PROJECTION.CurrentState,
        sourceJobId: job.jobId,
        sourceKind: job.kind,
    };
    // Build the facts-only sync payload for this range.
    const factsOnlyPayload: DomainSyncPayload = {
        fromBlock: range.fromBlock,
        toBlock: range.toBlock,
        mode,
        projection: DOMAIN_SYNC_PROJECTION.FactsOnly,
        sourceJobId: job.jobId,
        sourceKind: job.kind,
    };

    const activityJob: JobEnvelope<DomainSyncPayload> = {
        jobId: `domain:activity:${job.jobId}`,
        kind: DOMAIN_JOB_KIND.ActivitySync,
        queue: QUEUE_NAMES.ActivityDomain,
        payload: factsOnlyPayload,
        attempt: 0,
        scheduledAt: Date.now(),
        chainId,
        collectionId: job.collectionId,
    };

    await queue.publish(QUEUE_NAMES.ActivityDomain, activityJob);

    // Skip current-state fanout for fully pre-anchor ranges.
    if (!hasAnyCurrentStateProjection(collections, range)) {
        return;
    }

    const ordersJob: JobEnvelope<DomainSyncPayload> = {
        jobId: `domain:orders:${job.jobId}`,
        kind: DOMAIN_JOB_KIND.OrdersSync,
        queue: QUEUE_NAMES.OrdersDomain,
        payload: currentStatePayload,
        attempt: 0,
        scheduledAt: Date.now(),
        chainId,
        collectionId: job.collectionId,
    };
    const metadataJob: JobEnvelope<DomainSyncPayload> = {
        jobId: `domain:metadata:${job.jobId}`,
        kind: DOMAIN_JOB_KIND.MetadataSync,
        queue: QUEUE_NAMES.MetadataDomain,
        payload: currentStatePayload,
        attempt: 0,
        scheduledAt: Date.now(),
        chainId,
        collectionId: job.collectionId,
    };
    const currentStateData = filterCurrentStateOnChainData(collections, data);

    await queue.publish(QUEUE_NAMES.OrdersDomain, ordersJob);
    await queue.publish(QUEUE_NAMES.MetadataDomain, metadataJob);

    // Only post-anchor events may drive current-state side effects.
    await publishOrderUpdateJobs(
        queue,
        chainId,
        collections,
        currentStateData,
        orderMaintenancePolicy,
    );
    await publishMetadataRefreshJobs(
        queue,
        chainId,
        collections,
        currentStateData,
    );
}

export function resolveBackfillCollections(
    collectionRegistry: Pick<
        CollectionRegistryPort,
        "getCollection" | "listCollectionsForSync"
    >,
    chainId: number,
    collectionId: number | null,
): CollectionRecord[] {
    // Collection-scoped jobs stay pinned to one collection.
    if (!collectionId) {
        return collectionRegistry.listCollectionsForSync(chainId, "backfill");
    }

    const collection = collectionRegistry.getCollection(chainId, collectionId);
    if (!collection) return [];
    if (
        collection.status !== COLLECTION_STATUS.Live &&
        collection.status !== COLLECTION_STATUS.Bootstrapping
    ) {
        return [];
    }

    return [collection];
}

function resolveCollectionExtensionWatchSpecs(
    collectionExtensions: Pick<CollectionExtensionInstallPort, "getInstall">,
    chainId: number,
    collections: CollectionRecord[],
): CollectionExtensionSyncWatchSpec[] {
    // De-duplicate extension watches by install and source.
    const specs: CollectionExtensionSyncWatchSpec[] = [];
    const seen = new Set<string>();

    for (const collection of collections) {
        const install = collectionExtensions.getInstall(chainId, collection.id);
        if (!install?.enabled) {
            continue;
        }

        const extension = resolveIndexerCollectionExtension(install);
        if (!extension) {
            continue;
        }

        for (const spec of extension.buildSyncWatchSpecs(install)) {
            const dedupeKey = `${install.collectionId}:${install.extensionKey}:${spec.sourceId}`;
            if (seen.has(dedupeKey)) {
                continue;
            }
            seen.add(dedupeKey);
            specs.push(spec);
        }
    }

    return specs;
}

// Metadata refresh jobs are triggered by on-chain refresh events (e.g. ERC-4906).
async function publishMetadataRefreshJobs(
    queue: QueuePort,
    chainId: number,
    collections: CollectionRecord[],
    data: OnChainData,
): Promise<void> {
    const seen = new Set<string>();
    for (const refresh of data.collectionScoped.metadataRefreshEvents) {
        const collection = collections.find(
            (candidate) => candidate.id === refresh.collectionId,
        );
        if (!collection?.canProjectCurrentStateAt(refresh.blockNumber)) {
            continue;
        }
        const tokenId = refresh.tokenId;
        const collectionId = refresh.collectionId;
        const key = `${collectionId}:${tokenId}`;
        if (seen.has(key)) continue;
        seen.add(key);

        const job: JobEnvelope<MetadataRefreshPayload> = {
            jobId: `metadata:refresh:${chainId}:${collectionId}:${tokenId}:${refresh.blockNumber}:${refresh.logIndex}`,
            kind: DOMAIN_JOB_KIND.MetadataRefresh,
            queue: QUEUE_NAMES.MetadataRefresh,
            payload: {
                chainId,
                collectionId,
                tokenId,
                metadataUrl: null,
                reason: refresh.trigger,
                source: "onchain",
            },
            attempt: 0,
            scheduledAt: Date.now(),
            chainId,
            collectionId,
        };
        await queue.publish(QUEUE_NAMES.MetadataRefresh, job);
    }

    const seenRanges = new Set<string>();
    for (const refresh of data.collectionScoped.metadataRefreshRangeEvents) {
        const collection = collections.find(
            (candidate) => candidate.id === refresh.collectionId,
        );
        if (!collection?.canProjectCurrentStateAt(refresh.blockNumber)) {
            continue;
        }
        const key = `${refresh.collectionId}:${refresh.fromTokenId}:${refresh.toTokenId}`;
        if (seenRanges.has(key)) {
            continue;
        }
        seenRanges.add(key);

        const rangeJob: JobEnvelope<MetadataRefreshRangePayload> = {
            jobId: `metadata:refresh-range:${chainId}:${refresh.collectionId}:${refresh.fromTokenId}:${refresh.toTokenId}:${refresh.blockNumber}:${refresh.logIndex}`,
            kind: DOMAIN_JOB_KIND.MetadataRefreshRange,
            queue: QUEUE_NAMES.MetadataRefresh,
            payload: {
                chainId,
                collectionId: refresh.collectionId,
                fromTokenId: refresh.fromTokenId,
                toTokenId: refresh.toTokenId,
                cursorTokenId: refresh.fromTokenId,
                reason: refresh.trigger,
                source: "onchain",
            },
            attempt: 0,
            scheduledAt: Date.now(),
            chainId,
            collectionId: refresh.collectionId,
        };
        await queue.publish(QUEUE_NAMES.MetadataRefresh, rangeJob);
    }
}

async function appendWethMakerInfos(
    rpc: RpcProviderPort,
    range: SyncRange,
    wethAddress: string,
    bidderIndex: Pick<BidderIndex, "isActive" | "shouldEmit">,
    data: OnChainData,
    collections: CollectionRecord[],
    orderMaintenancePolicy: BackfillOrderMaintenancePolicy,
): Promise<void> {
    // WETH triggers only matter for current-state maker revalidation.
    if (
        !shouldFetchWethMakerLogs({
            orderMaintenancePolicy,
            range,
            bidderIndexActive: bidderIndex.isActive(),
            hasCurrentStateProjection: hasAnyCurrentStateProjection(
                collections,
                range,
            ),
        })
    ) {
        return;
    }

    const logs = await rpc.getLogs({
        fromBlock: range.fromBlock,
        toBlock: range.toBlock,
        address: wethAddress as Hex,
        events: WETH_EVENT_FILTERS,
    });
    const makers = decodeWethMakerInfos(logs, bidderIndex);
    data.global.makerTriggers.push(...makers);
}

function hasAnyCurrentStateProjection(
    collections: CollectionRecord[],
    range: SyncRange,
): boolean {
    // Coarse gate for current-state fanout.
    return collections.some(
        (collection) =>
            collection.intersectCurrentStateWindow(
                range.fromBlock,
                range.toBlock,
            ) !== null,
    );
}

function filterCurrentStateOnChainData(
    collections: CollectionRecord[],
    data: OnChainData,
): OnChainData {
    // Drop pre-anchor collection-scoped events.
    const collectionsById = new Map(
        collections.map((collection) => [collection.id, collection]),
    );

    return {
        transactions: data.transactions,
        collectionScoped: {
            nftTransferEvents: filterCurrentStateCollectionScopedEvents(
                collectionsById,
                data.collectionScoped.nftTransferEvents,
            ),
            nftApprovalEvents: filterCurrentStateCollectionScopedEvents(
                collectionsById,
                data.collectionScoped.nftApprovalEvents,
            ),
            nftBalanceDeltas: filterCurrentStateCollectionScopedEvents(
                collectionsById,
                data.collectionScoped.nftBalanceDeltas,
            ),
            fillEvents: filterCurrentStateCollectionScopedEvents(
                collectionsById,
                data.collectionScoped.fillEvents,
            ),
            orderInfos: filterCurrentStateCollectionScopedEvents(
                collectionsById,
                data.collectionScoped.orderInfos,
            ),
            makerTriggers: filterCurrentStateCollectionScopedEvents(
                collectionsById,
                data.collectionScoped.makerTriggers,
            ),
            metadataRefreshEvents: filterCurrentStateCollectionScopedEvents(
                collectionsById,
                data.collectionScoped.metadataRefreshEvents,
            ),
            metadataRefreshRangeEvents:
                filterCurrentStateCollectionScopedEvents(
                    collectionsById,
                    data.collectionScoped.metadataRefreshRangeEvents,
                ),
            collectionExtensionEvents: filterCurrentStateCollectionScopedEvents(
                collectionsById,
                data.collectionScoped.collectionExtensionEvents,
            ),
            collectionExtensionEventMedia:
                filterCurrentStateCollectionScopedEvents(
                    collectionsById,
                    data.collectionScoped.collectionExtensionEventMedia,
                ),
        },
        global: {
            cancelEvents: data.global.cancelEvents.filter((event) =>
                canAnyCollectionProjectCurrentStateAt(
                    collections,
                    event.blockNumber,
                ),
            ),
            makerTriggers: data.global.makerTriggers.filter((event) =>
                canAnyCollectionProjectCurrentStateAt(
                    collections,
                    event.blockNumber,
                ),
            ),
        },
    };
}

function filterCurrentStateCollectionScopedEvents<
    TEvent extends { collectionId: number; blockNumber: number },
>(collectionsById: Map<number, CollectionRecord>, events: TEvent[]): TEvent[] {
    // Keep only post-anchor collection-scoped events.
    return events.filter((event) =>
        collectionsById
            .get(event.collectionId)
            ?.canProjectCurrentStateAt(event.blockNumber),
    );
}
