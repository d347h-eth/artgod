import type { CollectionExtensionInstall } from "@artgod/shared/extensions";
import { logger } from "@artgod/shared/utils";
import { publishMetadataStatsRecompute } from "../metadata/stats-recompute.js";
import {
    COLLECTION_EXTENSION_JOB_KIND,
    type CollectionExtensionRefreshArtifactsPayload,
} from "../../domain/collection-extension-jobs.js";
import { METADATA_STATS_RECOMPUTE_REASON } from "../../domain/domain-jobs.js";
import type { JobEnvelope } from "../../domain/jobs.js";
import type {
    CollectionExtensionAttributePort,
    CollectionExtensionArtifactPort,
    CollectionExtensionInstallPort,
} from "../../ports/collection-extensions.js";
import type { MetadataFetcherPort } from "../../ports/metadata.js";
import type { QueuePort } from "../../ports/queue.js";
import type { RpcProviderPort } from "../../ports/rpc.js";
import { resolveIndexerCollectionExtension } from "./index.js";
import type { IndexerCollectionExtension } from "./types.js";

type CollectionExtensionResolver = (
    install: CollectionExtensionInstall,
) => IndexerCollectionExtension | null;

type CollectionExtensionRefreshArtifactsOptions = {
    installMissingError?: string;
    implementationMissingError?: string;
};

const COLLECTION_EXTENSION_WORKER_LOG_COMPONENT = "CollectionExtensionWorker";
const COLLECTION_EXTENSION_REFRESH_LOG_ACTION = "handleRefreshArtifacts";

// Handles one collection-extension artifact job and queues follow-up trait stats work.
export async function handleCollectionExtensionRefreshArtifactsJob(
    job: JobEnvelope<CollectionExtensionRefreshArtifactsPayload>,
    queue: QueuePort,
    rpc: RpcProviderPort,
    metadataFetcher: MetadataFetcherPort,
    installs: CollectionExtensionInstallPort,
    artifacts: CollectionExtensionArtifactPort,
    attributes: CollectionExtensionAttributePort,
    resolveExtension: CollectionExtensionResolver = resolveIndexerCollectionExtension,
    options: CollectionExtensionRefreshArtifactsOptions = {},
): Promise<void> {
    if (job.kind !== COLLECTION_EXTENSION_JOB_KIND.RefreshArtifacts) {
        return;
    }

    // Load the extension install before delegating collection-specific work.
    const install = installs.getInstall(
        job.payload.chainId,
        job.payload.collectionId,
    );

    if (!install?.enabled) {
        if (options.installMissingError) {
            throw new Error(options.installMissingError);
        }
        logger.debug(
            "Collection extension artifact refresh skipped; install missing",
            {
                component: COLLECTION_EXTENSION_WORKER_LOG_COMPONENT,
                action: COLLECTION_EXTENSION_REFRESH_LOG_ACTION,
                chainId: job.payload.chainId,
                collectionId: job.payload.collectionId,
                contract: job.payload.contract,
                tokenId: job.payload.tokenId,
                reason: job.payload.reason,
            },
        );
        return;
    }

    const extension = resolveExtension(install);
    if (!extension) {
        if (options.implementationMissingError) {
            throw new Error(options.implementationMissingError);
        }
        logger.warn(
            "Collection extension artifact refresh skipped; extension implementation missing",
            {
                component: COLLECTION_EXTENSION_WORKER_LOG_COMPONENT,
                action: COLLECTION_EXTENSION_REFRESH_LOG_ACTION,
                chainId: job.payload.chainId,
                collectionId: install.collectionId,
                extensionKey: install.extensionKey,
                contract: job.payload.contract,
                tokenId: job.payload.tokenId,
            },
        );
        return;
    }

    // Let the installed extension refresh its artifacts and normalized traits.
    const refreshResult = await extension.refreshArtifacts({
        rpc,
        metadataFetcher,
        installs,
        artifacts,
        attributes,
        install,
        payload: {
            chainId: job.payload.chainId,
            collectionId: install.collectionId,
            contract: job.payload.contract,
            tokenId: job.payload.tokenId,
            reason: job.payload.reason,
            source: job.payload.source,
        },
    });
    if (refreshResult.attributesChanged) {
        // Recompute trait stats only when extension-owned trait rows changed.
        await publishMetadataStatsRecompute(
            queue,
            {
                chainId: job.payload.chainId,
                collectionId: install.collectionId,
                reason: METADATA_STATS_RECOMPUTE_REASON.CollectionExtensionTraits,
                sourceJobId: job.jobId,
            },
            job.traceId ?? job.jobId,
        );
    }
}
