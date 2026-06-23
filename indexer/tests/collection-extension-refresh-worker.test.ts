import { describe, expect, it } from "vitest";
import type { CollectionExtensionInstall } from "@artgod/shared/extensions";
import { TERRAFORMS_EXTENSION_KEY } from "@artgod/shared/extensions/terraforms";
import { handleCollectionExtensionRefreshArtifactsJob } from "../src/application/collection-extensions/refresh-artifacts-worker.js";
import type {
    CollectionExtensionArtifactRefreshContext,
    IndexerCollectionExtension,
} from "../src/application/collection-extensions/types.js";
import {
    COLLECTION_EXTENSION_JOB_KIND,
    type CollectionExtensionRefreshArtifactsPayload,
} from "../src/domain/collection-extension-jobs.js";
import {
    DOMAIN_JOB_KIND,
    METADATA_STATS_RECOMPUTE_REASON,
    type MetadataStatsRecomputePayload,
} from "../src/domain/domain-jobs.js";
import type { JobEnvelope } from "../src/domain/jobs.js";
import { QUEUE_NAMES, type QueueName } from "../src/domain/queues.js";
import type {
    CollectionExtensionAttributePort,
    CollectionExtensionArtifactPort,
    CollectionExtensionInstallPort,
    CollectionExtensionSyntheticTokenPort,
} from "../src/ports/collection-extensions.js";
import type { MetadataFetcherPort } from "../src/ports/metadata.js";
import type {
    QueueMessage,
    QueuePort,
    SubscribeOptions,
} from "../src/ports/queue.js";
import type {
    RpcBlock,
    RpcLog,
    RpcLogFilter,
    RpcProviderPort,
    RpcTransaction,
    RpcTransactionReceipt,
} from "../src/ports/rpc.js";

const CHAIN_ID = 1;
const COLLECTION_ID = 7;
const TEST_CONTRACT = "0xabc0000000000000000000000000000000000000";
const TEST_TOKEN_ID = "7710";
const TEST_REFRESH_REASON = "test-refresh";
const TEST_REFRESH_SOURCE = "test-source";
const TEST_JOB_ID = "collection-extension-refresh-test-job";
const TEST_TRACE_ID = "collection-extension-refresh-test-trace";
const TEST_METADATA_REFRESH_RUN_ID = "metadata-refresh-test-run";
const TEST_INSTALL_MISSING_ERROR = "collection-extension-install-missing";
const TEST_IMPLEMENTATION_MISSING_ERROR =
    "collection-extension-implementation-missing";

describe("collection extension refresh worker handler", () => {
    it("publishes metadata stats recompute when extension attributes change", async () => {
        const queue = new RecordingQueue();
        const install = buildInstall();
        const installs = buildInstallPort(install);
        const artifacts = buildArtifactPort();
        const attributes = buildAttributePort();
        const rpc = buildUnusedRpc();
        const metadataFetcher = buildMetadataFetcher();
        let receivedContext: CollectionExtensionArtifactRefreshContext | null =
            null;
        const extension = buildExtension({
            attributesChanged: true,
            onRefresh(context) {
                receivedContext = context;
            },
        });

        await handleCollectionExtensionRefreshArtifactsJob(
            buildRefreshJob(),
            queue,
            rpc,
            metadataFetcher,
            installs,
            artifacts,
            attributes,
            buildSyntheticTokenPort(),
            (resolvedInstall) => {
                expect(resolvedInstall).toBe(install);
                return extension;
            },
        );

        expect(receivedContext).toMatchObject({
            rpc,
            metadataFetcher,
            installs,
            artifacts,
            attributes,
            install,
            payload: {
                chainId: CHAIN_ID,
                collectionId: COLLECTION_ID,
                contract: TEST_CONTRACT,
                tokenId: TEST_TOKEN_ID,
                reason: TEST_REFRESH_REASON,
                source: TEST_REFRESH_SOURCE,
            },
        });
        expect(queue.published).toHaveLength(1);
        const published = queue.published[0]!;
        expect(published.queue).toBe(QUEUE_NAMES.MetadataStats);
        expect(published.message.kind).toBe(
            DOMAIN_JOB_KIND.MetadataStatsRecompute,
        );
        expect(published.message.traceId).toBe(TEST_TRACE_ID);
        expect(published.message.chainId).toBe(CHAIN_ID);
        expect(published.message.collectionId).toBe(COLLECTION_ID);
        expect(
            published.message.payload as MetadataStatsRecomputePayload,
        ).toEqual({
            chainId: CHAIN_ID,
            collectionId: COLLECTION_ID,
            reason: METADATA_STATS_RECOMPUTE_REASON.CollectionExtensionTraits,
            sourceJobId: TEST_JOB_ID,
        });
    });

    it("does not publish metadata stats recompute when extension attributes are unchanged", async () => {
        const queue = new RecordingQueue();
        const extension = buildExtension({ attributesChanged: false });

        await handleCollectionExtensionRefreshArtifactsJob(
            buildRefreshJob(),
            queue,
            buildUnusedRpc(),
            buildMetadataFetcher(),
            buildInstallPort(buildInstall()),
            buildArtifactPort(),
            buildAttributePort(),
            buildSyntheticTokenPort(),
            () => extension,
        );

        expect(queue.published).toEqual([]);
    });

    it("does not publish metadata stats recompute for metadata-refresh owned jobs", async () => {
        const queue = new RecordingQueue();
        const extension = buildExtension({ attributesChanged: true });

        const result = await handleCollectionExtensionRefreshArtifactsJob(
            buildRefreshJob({
                metadataRefreshRunId: TEST_METADATA_REFRESH_RUN_ID,
                metadataRefreshExtensionKey: TERRAFORMS_EXTENSION_KEY,
            }),
            queue,
            buildUnusedRpc(),
            buildMetadataFetcher(),
            buildInstallPort(buildInstall()),
            buildArtifactPort(),
            buildAttributePort(),
            buildSyntheticTokenPort(),
            () => extension,
        );

        expect(result.attributesChanged).toBe(true);
        expect(queue.published).toEqual([]);
    });

    it("throws the configured missing-install error for bootstrap callers", async () => {
        const queue = new RecordingQueue();

        await expect(
            handleCollectionExtensionRefreshArtifactsJob(
                buildRefreshJob(),
                queue,
                buildUnusedRpc(),
                buildMetadataFetcher(),
                buildInstallPort(null),
                buildArtifactPort(),
                buildAttributePort(),
                buildSyntheticTokenPort(),
                undefined,
                { installMissingError: TEST_INSTALL_MISSING_ERROR },
            ),
        ).rejects.toThrow(TEST_INSTALL_MISSING_ERROR);

        expect(queue.published).toEqual([]);
    });

    it("throws the configured missing-implementation error for bootstrap callers", async () => {
        const queue = new RecordingQueue();

        await expect(
            handleCollectionExtensionRefreshArtifactsJob(
                buildRefreshJob(),
                queue,
                buildUnusedRpc(),
                buildMetadataFetcher(),
                buildInstallPort(buildInstall()),
                buildArtifactPort(),
                buildAttributePort(),
                buildSyntheticTokenPort(),
                () => null,
                {
                    implementationMissingError:
                        TEST_IMPLEMENTATION_MISSING_ERROR,
                },
            ),
        ).rejects.toThrow(TEST_IMPLEMENTATION_MISSING_ERROR);

        expect(queue.published).toEqual([]);
    });
});

class RecordingQueue implements QueuePort {
    readonly published: Array<{
        queue: QueueName;
        message: JobEnvelope<unknown>;
    }> = [];

    async publish<TPayload>(
        queue: QueueName,
        message: JobEnvelope<TPayload>,
    ): Promise<void> {
        this.published.push({
            queue,
            message: message as JobEnvelope<unknown>,
        });
    }

    async subscribe<TPayload>(
        _queue: QueueName,
        _handler: (message: QueueMessage<TPayload>) => Promise<void>,
        _options: SubscribeOptions,
    ): Promise<() => Promise<void>> {
        throw new Error("RecordingQueue does not support subscribe");
    }

    async close(): Promise<void> {}
}

function buildRefreshJob(
    payload: Partial<CollectionExtensionRefreshArtifactsPayload> = {},
): JobEnvelope<CollectionExtensionRefreshArtifactsPayload> {
    return {
        jobId: TEST_JOB_ID,
        kind: COLLECTION_EXTENSION_JOB_KIND.RefreshArtifacts,
        queue: QUEUE_NAMES.CollectionExtensionArtifacts,
        payload: {
            chainId: CHAIN_ID,
            collectionId: COLLECTION_ID,
            contract: TEST_CONTRACT,
            tokenId: TEST_TOKEN_ID,
            reason: TEST_REFRESH_REASON,
            source: TEST_REFRESH_SOURCE,
            ...payload,
        },
        attempt: 0,
        scheduledAt: 0,
        chainId: CHAIN_ID,
        collectionId: COLLECTION_ID,
        traceId: TEST_TRACE_ID,
    };
}

function buildInstall(): CollectionExtensionInstall {
    return {
        chainId: CHAIN_ID,
        collectionId: COLLECTION_ID,
        extensionKey: TERRAFORMS_EXTENSION_KEY,
        enabled: true,
        configJson: "{}",
        createdAt: "2026-06-12T00:00:00.000Z",
        updatedAt: "2026-06-12T00:00:00.000Z",
    };
}

function buildExtension(input: {
    attributesChanged: boolean;
    onRefresh?: (context: CollectionExtensionArtifactRefreshContext) => void;
}): IndexerCollectionExtension {
    return {
        key: TERRAFORMS_EXTENSION_KEY,
        buildSyncWatchSpecs() {
            return [];
        },
        async refreshArtifacts(context) {
            input.onRefresh?.(context);
            return { attributesChanged: input.attributesChanged };
        },
    };
}

function buildInstallPort(
    install: CollectionExtensionInstall | null,
): CollectionExtensionInstallPort {
    return {
        getInstall(chainId, collectionId) {
            return install &&
                chainId === install.chainId &&
                collectionId === install.collectionId
                ? install
                : null;
        },
        listEnabledInstalls(chainId) {
            return install && chainId === install.chainId ? [install] : [];
        },
        upsertInstall() {},
    };
}

function buildArtifactPort(): CollectionExtensionArtifactPort {
    return {
        upsertArtifact() {},
        getArtifact() {
            return null;
        },
        getTokenAttributeValue() {
            return null;
        },
    };
}

function buildAttributePort(): CollectionExtensionAttributePort {
    return {
        replaceTokenAttributes() {},
    };
}

function buildSyntheticTokenPort(): CollectionExtensionSyntheticTokenPort {
    return {
        upsertSyntheticToken() {},
        retireSyntheticToken() {
            return {
                retired: false,
                blockedByCanonicalState: false,
            };
        },
    };
}

function buildMetadataFetcher(): MetadataFetcherPort {
    return {
        async fetchMetadata() {
            return null;
        },
    };
}

function buildUnusedRpc(): RpcProviderPort {
    return {
        async getBlockNumber(): Promise<number> {
            return unusedRpcCall();
        },
        async getBlock(_blockNumber: number): Promise<RpcBlock> {
            return unusedRpcCall();
        },
        async getLogs(_filter: RpcLogFilter): Promise<RpcLog[]> {
            return unusedRpcCall();
        },
        async getTransaction(_txHash: string): Promise<RpcTransaction> {
            return unusedRpcCall();
        },
        async getTransactionReceipt(
            _txHash: string,
        ): Promise<RpcTransactionReceipt> {
            return unusedRpcCall();
        },
        async readContract<T>(): Promise<T> {
            return unusedRpcCall();
        },
        async getBalance(): Promise<bigint> {
            return unusedRpcCall();
        },
    };
}

function unusedRpcCall(): never {
    throw new Error("Unexpected RPC call in collection extension worker test");
}
