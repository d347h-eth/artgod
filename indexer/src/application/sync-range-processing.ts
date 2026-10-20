import {
    SYNC_FOLLOW_UP_KIND,
    eventSyncFollowUp,
    type SyncFollowUp,
} from "../domain/sync-follow-ups.js";
import { syncRange, type SyncRange } from "./sync.js";
import { COLLECTION_STATUS } from "@artgod/shared/types";
import { SYNC_WORK_CLASS } from "@artgod/shared/types/sync-work-class";
import {
    SYNC_APPLICATION_KIND,
    SYNC_WORK_COMPLETION,
    type SyncApplication,
} from "../domain/sync-work.js";
import { fetchCanonicalSyncBlocks } from "./sync-blocks.js";
import { resolveIndexerCollectionExtension } from "./collection-extensions/index.js";
import type { CollectionExtensionSyncWatchSpec } from "./collection-extensions/types.js";
import { decodeWethMakerInfos, WETH_EVENT_FILTERS } from "./ft/weth.js";
import { buildOrderUpdateFollowUps } from "./order-update-fanout.js";
import type { JobEnvelope } from "../domain/jobs.js";
import { QUEUE_NAMES } from "../domain/queues.js";
import {
    DOMAIN_JOB_KIND,
    DOMAIN_SYNC_PROJECTION,
    type DomainSyncMode,
    type DomainSyncSource,
    type DomainSyncPayload,
    type MetadataRefreshPayload,
    type MetadataRefreshRangePayload,
} from "../domain/domain-jobs.js";
import type { OnChainData } from "../domain/onchain.js";
import type { BackfillOrderMaintenancePolicy } from "../domain/sync-jobs.js";
import type { CollectionRecord } from "../domain/collections.js";
import type { Hex, RpcBlock, RpcProviderPort } from "../ports/rpc.js";
import type { StoragePort, SyncRangeResult } from "../ports/storage.js";
import type { SyncRangeCommitPort } from "../ports/sync-range-commit.js";
import type { SyncWorkCompletion } from "../domain/sync-work.js";
import {
    ChainSyncConflict,
    StoredBlockHashConflict,
} from "../domain/chain-sync.js";
import type { CanonicalChecksPort } from "../ports/canonical-checks.js";
import type {
    CollectionRegistryPort,
    CollectionScopeResolverPort,
} from "../ports/collections.js";
import type { CollectionExtensionInstallPort } from "../ports/collection-extensions.js";

export async function acquireSyncRange(input: {
    rpc: RpcProviderPort;
    storage: StoragePort;
    collectionScopeResolver: CollectionScopeResolverPort;
    collectionExtensions: Pick<CollectionExtensionInstallPort, "getInstall">;
    chainId: number;
    reorgDepth: number;
    collections: CollectionRecord[];
    range: SyncRange;
    application: SyncApplication;
    wethAddress: string;
    orderMaintenancePolicy: BackfillOrderMaintenancePolicy;
}): Promise<SyncRangeResult> {
    const {
        rpc,
        storage,
        collectionScopeResolver,
        collectionExtensions,
        chainId,
        collections,
        range,
        application,
        wethAddress,
        orderMaintenancePolicy,
    } = input;
    const checkpoint = storage.captureSyncCheckpoint(chainId);
    if (application.kind === SYNC_APPLICATION_KIND.Applied) {
        for (const expected of [
            application.chain,
            ...application.collections,
        ]) {
            if (
                expected &&
                (expected.checkpoint.chainId !== chainId ||
                    expected.checkpoint.revision !== checkpoint.revision)
            )
                throw new ChainSyncConflict(
                    "Sync application predates the current chain revision",
                );
        }
    }
    // Classify maturity at fetch time. A delayed commit must retain the check
    // required by data fetched while unconfirmed; historical imports add none.
    const observedHeadBlock = await rpc.getBlockNumber();
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
    if (application.kind === SYNC_APPLICATION_KIND.Applied && application.chain)
        await appendWethMakerInfos(rpc, range, wethAddress, data);
    const blocks = await fetchCanonicalSyncBlocks({ rpc, ...range });
    return {
        checkpoint,
        application,
        canonicalCheck: { observedHeadBlock, reorgDepth: input.reorgDepth },
        blocks,
        data,
        collections,
    };
}

export type SyncRangeInput = Parameters<typeof acquireSyncRange>[0];

// Production sync acquisition ends at durable retention, independent of broker
// availability. The outbox owns publication; it never repeats remote acquisition.
export async function processSyncRange(
    input: SyncRangeInput & {
        commit: SyncRangeCommitPort;
        canonicalChecks: Pick<CanonicalChecksPort, "retain">;
        sources: readonly DomainSyncSource[];
        mode: DomainSyncMode;
        completion: SyncWorkCompletion;
    },
): Promise<SyncRangeResult> {
    const result = await acquireSyncRange(input);
    const followUps = buildSyncFollowUps(
        input.chainId,
        input.collections,
        input.range,
        input.sources,
        input.mode,
        result.data,
        input.orderMaintenancePolicy,
        result.application,
    ).map((followUp) => ({
        ...followUp,
        job: {
            ...followUp.job,
            workClass:
                input.completion.kind === SYNC_WORK_COMPLETION.GapRepair
                    ? SYNC_WORK_CLASS.GapRepair
                    : SYNC_WORK_CLASS.Main,
        },
    }));
    try {
        input.commit.commitSyncRange({
            result,
            followUps,
            completion: input.completion,
        });
    } catch (error) {
        // A failed sync writer cannot retain work inside its rolled-back transaction.
        // Let the existing reorg owner freshly verify this exact stored identity.
        if (error instanceof StoredBlockHashConflict)
            input.canonicalChecks.retain(error.check, { disputed: true });
        throw error;
    }
    return result;
}

export function domainSyncSource(
    job: Pick<JobEnvelope, "jobId" | "kind" | "collectionId">,
): DomainSyncSource {
    return {
        fanoutId: job.jobId,
        sourceJobId: job.jobId,
        sourceKind: job.kind,
        collectionId: job.collectionId,
    };
}

export function buildSyncFollowUps(
    chainId: number,
    collections: CollectionRecord[],
    range: SyncRange,
    sources: readonly DomainSyncSource[],
    mode: DomainSyncMode,
    data: OnChainData,
    orderMaintenancePolicy: BackfillOrderMaintenancePolicy,
    application: SyncApplication,
): SyncFollowUp[] {
    const followUps: SyncFollowUp[] = [];
    const collectionIds = new Set(
        collections.map((collection) => collection.id),
    );
    if (
        !sources.length ||
        sources.some((source) =>
            source.collectionId === undefined
                ? sources.length !== 1
                : !collectionIds.has(source.collectionId),
        )
    )
        throw new Error(
            "Domain sync sources do not match the acquired collections",
        );
    // Grouped repairs retain collection-scoped domain identities. Shared event
    // fanout below runs once for the whole acquisition, including global hints.
    for (const source of sources) {
        const targetCollections =
            source.collectionId === undefined
                ? collections
                : collections.filter(
                      (collection) => collection.id === source.collectionId,
                  );
        // Build the current-state sync payload for this range.
        const currentStatePayload: DomainSyncPayload = {
            fromBlock: range.fromBlock,
            toBlock: range.toBlock,
            mode,
            projection: DOMAIN_SYNC_PROJECTION.CurrentState,
            sourceJobId: source.sourceJobId,
            sourceKind: source.sourceKind,
        };
        // Build the facts-only sync payload for this range.
        const factsOnlyPayload: DomainSyncPayload = {
            fromBlock: range.fromBlock,
            toBlock: range.toBlock,
            mode,
            projection: DOMAIN_SYNC_PROJECTION.FactsOnly,
            sourceJobId: source.sourceJobId,
            sourceKind: source.sourceKind,
        };

        const activityJob: JobEnvelope<DomainSyncPayload> = {
            jobId: `domain:activity:${source.fanoutId}`,
            kind: DOMAIN_JOB_KIND.ActivitySync,
            queue: QUEUE_NAMES.ActivityDomain,
            payload: factsOnlyPayload,
            attempt: 0,
            scheduledAt: Date.now(),
            chainId,
            collectionId: source.collectionId,
        };

        followUps.push({ kind: SYNC_FOLLOW_UP_KIND.Range, job: activityJob });

        // Skip current-state fanout for fully pre-anchor ranges.
        if (
            application.kind === SYNC_APPLICATION_KIND.Historical ||
            !hasAnyCurrentStateProjection(targetCollections, range)
        ) {
            continue;
        }

        const ordersJob: JobEnvelope<DomainSyncPayload> = {
            jobId: `domain:orders:${source.fanoutId}`,
            kind: DOMAIN_JOB_KIND.OrdersSync,
            queue: QUEUE_NAMES.OrdersDomain,
            payload: currentStatePayload,
            attempt: 0,
            scheduledAt: Date.now(),
            chainId,
            collectionId: source.collectionId,
        };
        const metadataJob: JobEnvelope<DomainSyncPayload> = {
            jobId: `domain:metadata:${source.fanoutId}`,
            kind: DOMAIN_JOB_KIND.MetadataSync,
            queue: QUEUE_NAMES.MetadataDomain,
            payload: currentStatePayload,
            attempt: 0,
            scheduledAt: Date.now(),
            chainId,
            collectionId: source.collectionId,
        };
        followUps.push({ kind: SYNC_FOLLOW_UP_KIND.Range, job: ordersJob });
        followUps.push({ kind: SYNC_FOLLOW_UP_KIND.Range, job: metadataJob });
    }
    if (application.kind === SYNC_APPLICATION_KIND.Historical) return followUps;
    const currentStateData = filterCurrentStateOnChainData(collections, data);

    // Retain every post-anchor event hint, including hints absent from raw facts.
    followUps.push(
        ...buildOrderUpdateFollowUps(
            chainId,
            collections,
            currentStateData,
            orderMaintenancePolicy,
            application.chain !== null,
        ),
    );
    followUps.push(
        ...buildMetadataRefreshFollowUps(
            chainId,
            collections,
            currentStateData,
        ),
    );
    return followUps;
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
function buildMetadataRefreshFollowUps(
    chainId: number,
    collections: CollectionRecord[],
    data: OnChainData,
): SyncFollowUp[] {
    const followUps: SyncFollowUp[] = [];
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
        followUps.push(eventSyncFollowUp(job, refresh));
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
        followUps.push(eventSyncFollowUp(rangeJob, refresh));
    }
    return followUps;
}

async function appendWethMakerInfos(
    rpc: RpcProviderPort,
    range: SyncRange,
    wethAddress: string,
    data: OnChainData,
): Promise<void> {
    const logs = await rpc.getLogs({
        fromBlock: range.fromBlock,
        toBlock: range.toBlock,
        address: wethAddress as Hex,
        events: WETH_EVENT_FILTERS,
    });
    const makers = decodeWethMakerInfos(logs);
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
        global: data.global,
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
