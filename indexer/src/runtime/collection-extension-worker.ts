import { createMigrationRunner } from "@artgod/shared/migrations";
import { setDbPath } from "@artgod/shared/database";
import { logger } from "@artgod/shared/utils";
import { loadConfig } from "../config/index.js";
import { resolveIndexerCollectionExtension } from "../application/collection-extensions/index.js";
import { runWorker } from "../application/worker-runner.js";
import {
    COLLECTION_EXTENSION_JOB_KIND,
    type CollectionExtensionRefreshArtifactsPayload,
} from "../domain/collection-extension-jobs.js";
import type { JobEnvelope } from "../domain/jobs.js";
import { QUEUE_NAMES } from "../domain/queues.js";
import { SqliteCollectionExtensions } from "../infra/collection-extensions/sqlite.js";
import { HttpMetadataFetcher } from "../infra/metadata/http-fetcher.js";
import { NatsJetStreamQueue } from "../infra/queue/nats.js";
import { ViemRpcProvider } from "../infra/rpc/viem.js";
import { initRuntimeMetrics } from "../metrics/runtime.js";
import { initRuntimeApm } from "../observability/apm.js";

async function main() {
    try {
        const config = loadConfig();
        setDbPath(config.dbPath);
        const runtimeApm = await initRuntimeApm({
            enabled: config.apm.enabled,
            serviceNamespace: config.apm.serviceNamespace,
            spanProfiles: config.apm.spanProfiles,
            worker: "collection-extension-worker",
            chainId: config.chainId,
            traces: config.apm.traces,
            profiles: config.apm.profiles,
        });
        const runtimeMetrics = await initRuntimeMetrics({
            enabled: config.metrics.enabled,
            host: config.metrics.host,
            port: config.metrics.ports.collectionExtensionWorker,
            worker: "collection-extension-worker",
            chainId: config.chainId,
        });
        const migrations = createMigrationRunner();
        await migrations.runMigrations();
        const queue = await NatsJetStreamQueue.connect({
            natsUrl: config.queue.natsUrl,
            streamPrefix: config.queue.streamPrefix,
        });
        const rpc = new ViemRpcProvider({
            url: config.rpc.primaryUrl,
            logChunkSize: config.sync.logChunkSize,
            metrics: runtimeMetrics.metrics,
            retryPolicy: config.rpc.retryPolicy,
            resilience: config.rpc.resilience,
        });
        const collectionExtensions = new SqliteCollectionExtensions();
        const metadataFetcher = new HttpMetadataFetcher({
            metrics: runtimeMetrics.metrics,
        });

        const stopWorker = await runWorker(
            queue,
            {
                queue: QUEUE_NAMES.CollectionExtensionArtifacts,
                consumerName: `collection-extension-artifacts-${config.chainId}`,
                maxInFlight: 1,
                maxAttempts: 5,
                deadLetterQueue: QUEUE_NAMES.DeadLetter,
            },
            async (job: JobEnvelope<CollectionExtensionRefreshArtifactsPayload>) => {
                if (job.kind !== COLLECTION_EXTENSION_JOB_KIND.RefreshArtifacts) {
                    return;
                }

                const install =
                    (job.payload.collectionId
                        ? collectionExtensions.getInstall(
                              job.payload.chainId,
                              job.payload.collectionId,
                          )
                        : null) ??
                    collectionExtensions.getInstallByContract(
                        job.payload.chainId,
                        job.payload.contract,
                    );

                if (!install?.enabled) {
                    logger.debug(
                        "Collection extension artifact refresh skipped; install missing",
                        {
                            component: "CollectionExtensionWorker",
                            action: "handleRefreshArtifacts",
                            chainId: job.payload.chainId,
                            collectionId: job.payload.collectionId ?? null,
                            contract: job.payload.contract,
                            tokenId: job.payload.tokenId,
                            reason: job.payload.reason,
                        },
                    );
                    return;
                }

                const extension = resolveIndexerCollectionExtension(install);
                if (!extension) {
                    logger.warn(
                        "Collection extension artifact refresh skipped; extension implementation missing",
                        {
                            component: "CollectionExtensionWorker",
                            action: "handleRefreshArtifacts",
                            chainId: job.payload.chainId,
                            collectionId: install.collectionId,
                            extensionKey: install.extensionKey,
                            contract: job.payload.contract,
                            tokenId: job.payload.tokenId,
                        },
                    );
                    return;
                }

                await extension.refreshArtifacts({
                    rpc,
                    metadataFetcher,
                    installs: collectionExtensions,
                    artifacts: collectionExtensions,
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
            },
            {
                apm: runtimeApm.apm,
                spanName: "worker.collectionExtension.consume",
            },
        );

        logger.info("Collection extension worker ready", {
            component: "CollectionExtensionWorker",
            action: "main",
        });

        const shutdown = async () => {
            logger.info("Collection extension worker shutting down", {
                component: "CollectionExtensionWorker",
                action: "shutdown",
            });
            await stopWorker();
            await runtimeApm.stop();
            await runtimeMetrics.stop();
            await queue.close();
            process.exit(0);
        };

        process.on("SIGINT", shutdown);
        process.on("SIGTERM", shutdown);
    } catch (error) {
        logger.error("Collection extension worker startup failed", {
            component: "CollectionExtensionWorker",
            action: "main",
            error: String(error),
        });
        process.exit(1);
    }
}

main();
