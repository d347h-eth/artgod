import { createMigrationRunner } from "@artgod/shared/migrations";
import { setDbPath } from "@artgod/shared/database";
import { logger } from "@artgod/shared/utils";
import { loadConfig } from "../config/index.js";
import { runWorker } from "../application/worker-runner.js";
import {
    normalizeOffchainOrder,
    normalizeOffchainMetadataRefresh,
    normalizeOffchainOrderUpdateById,
} from "../application/offchain/normalize.js";
import type { JobEnvelope } from "../domain/jobs.js";
import {
    OFFCHAIN_JOB_KIND,
    type OffchainOrderRawPayload,
} from "../domain/offchain-jobs.js";
import { DOMAIN_JOB_KIND } from "../domain/domain-jobs.js";
import {
    ORDER_JOB_KIND,
    type OrderUpdateByIdPayload,
    type OrderUpsertPayload,
} from "../domain/order-jobs.js";
import type { MetadataRefreshPayload } from "../domain/domain-jobs.js";
import { QUEUE_NAMES } from "../domain/queues.js";
import { NatsJetStreamQueue } from "../infra/queue/nats.js";
import { SqliteTokenSetRegistry } from "../infra/token-sets/sqlite.js";
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
            worker: "offchain-ingest-worker",
            chainId: config.chainId,
            traces: config.apm.traces,
            profiles: config.apm.profiles,
        });
        const runtimeMetrics = await initRuntimeMetrics({
            enabled: config.metrics.enabled,
            host: config.metrics.host,
            port: config.metrics.ports.offchainIngestWorker,
            worker: "offchain-ingest-worker",
            chainId: config.chainId,
        });
        const migrations = createMigrationRunner();
        await migrations.runMigrations();
        const queue = await NatsJetStreamQueue.connect({
            natsUrl: config.queue.natsUrl,
            streamPrefix: config.queue.streamPrefix,
        });
        const tokenSets = new SqliteTokenSetRegistry();

        // Convert raw offchain payloads into normalized order upserts.
        const stopIngest = await runWorker(
            queue,
            {
                queue: QUEUE_NAMES.OffchainOrdersRaw,
                consumerName: `offchain-ingest-${config.chainId}`,
                maxInFlight: 1,
                maxAttempts: 5,
                deadLetterQueue: QUEUE_NAMES.DeadLetter,
            },
            async (job: JobEnvelope<OffchainOrderRawPayload>) => {
                if (job.kind !== OFFCHAIN_JOB_KIND.OrderRaw) return;
                if (
                    await handleOffchainOrderUpsert(
                        queue,
                        tokenSets,
                        job.payload,
                    )
                ) {
                    return;
                }

                if (await handleOffchainOrderUpdate(queue, job.payload)) {
                    return;
                }

                await handleOffchainMetadataRefresh(queue, job.payload);
            },
            {
                apm: runtimeApm.apm,
                spanName: "worker.offchainIngest.consume",
            },
        );

        logger.info("Offchain ingest worker ready", {
            component: "OffchainIngestWorker",
            action: "main",
        });

        const shutdown = async () => {
            logger.info("Offchain ingest worker shutting down", {
                component: "OffchainIngestWorker",
                action: "shutdown",
            });
            await stopIngest();
            await runtimeApm.stop();
            await runtimeMetrics.stop();
            await queue.close();
            process.exit(0);
        };

        process.on("SIGINT", shutdown);
        process.on("SIGTERM", shutdown);
        process.stdin.resume();
    } catch (error) {
        logger.error("Offchain ingest worker startup failed", {
            component: "OffchainIngestWorker",
            action: "main",
            error: String(error),
        });
        process.exit(1);
    }
}

main();

async function handleOffchainOrderUpsert(
    queue: NatsJetStreamQueue,
    tokenSets: SqliteTokenSetRegistry,
    payload: OffchainOrderRawPayload,
): Promise<boolean> {
    const normalized = normalizeOffchainOrder(payload);
    if (!normalized) return false;

    let tokenSetId: string | null = null;
    let tokenSetSchemaHash: string | null = null;
    if (normalized.tokenSetSchema) {
        const resolved = tokenSets.ensureTokenSet({
            chainId: normalized.chainId,
            schema: normalized.tokenSetSchema,
            criteriaRoot: normalized.criteriaRoot ?? null,
        });
        if (!resolved) {
            logger.warn("Offchain token set unresolved", {
                component: "OffchainIngestWorker",
                action: "normalize",
                source: normalized.source,
                orderId: normalized.orderId,
                chainId: normalized.chainId,
            });
            return true;
        }
        tokenSetId = resolved.tokenSetId;
        tokenSetSchemaHash = resolved.schemaHash;
    }

    const upsertJob: JobEnvelope<OrderUpsertPayload> = {
        jobId: `orders:upsert:${normalized.chainId}:${normalized.orderId}:${payload.receivedAt}`,
        kind: ORDER_JOB_KIND.Upsert,
        queue: QUEUE_NAMES.OrdersUpsert,
        payload: {
            chainId: normalized.chainId,
            orderId: normalized.orderId,
            kind: normalized.kind,
            side: normalized.side,
            maker: normalized.maker,
            taker: normalized.taker ?? null,
            contract: normalized.contract,
            tokenId: normalized.tokenId ?? null,
            tokenSetId,
            tokenSetSchemaHash,
            price: normalized.price ?? null,
            currency: normalized.currency ?? null,
            validFrom: normalized.validFrom ?? null,
            validUntil: normalized.validUntil ?? null,
            source: normalized.source,
            rawData: normalized.rawData,
            validateAfterUpsert: true,
        },
        attempt: 0,
        scheduledAt: Date.now(),
        chainId: normalized.chainId,
    };
    await queue.publish(QUEUE_NAMES.OrdersUpsert, upsertJob);

    logger.debug("Offchain order normalized", {
        component: "OffchainIngestWorker",
        action: "normalize",
        source: normalized.source,
        orderId: normalized.orderId,
        chainId: normalized.chainId,
    });

    return true;
}

async function handleOffchainOrderUpdate(
    queue: NatsJetStreamQueue,
    payload: OffchainOrderRawPayload,
): Promise<boolean> {
    const updateById = normalizeOffchainOrderUpdateById(payload);
    if (!updateById) return false;

    const updateJob: JobEnvelope<OrderUpdateByIdPayload> = {
        jobId: `orders:update:id:offchain:${updateById.chainId}:${updateById.orderId}:${payload.receivedAt}`,
        kind: ORDER_JOB_KIND.UpdateById,
        queue: QUEUE_NAMES.OrdersUpdateById,
        payload: {
            chainId: updateById.chainId,
            orderId: updateById.orderId,
            reason: updateById.reason,
            blockNumber: 0,
            blockHash: "0x0",
            txHash: "0x0",
            logIndex: 0,
        },
        attempt: 0,
        scheduledAt: Date.now(),
        chainId: updateById.chainId,
        traceId: payload.source ?? payload.receivedAt.toString(),
    };
    await queue.publish(QUEUE_NAMES.OrdersUpdateById, updateJob);

    logger.debug("Offchain order update normalized", {
        component: "OffchainIngestWorker",
        action: "normalize",
        source: updateById.source,
        orderId: updateById.orderId,
        reason: updateById.reason,
        chainId: updateById.chainId,
    });

    return true;
}

async function handleOffchainMetadataRefresh(
    queue: NatsJetStreamQueue,
    payload: OffchainOrderRawPayload,
): Promise<boolean> {
    const metadataRefresh = normalizeOffchainMetadataRefresh(payload);
    if (metadataRefresh) {
        const refreshJob: JobEnvelope<MetadataRefreshPayload> = {
            jobId: `metadata:refresh:offchain:${metadataRefresh.chainId}:${metadataRefresh.contract}:${metadataRefresh.tokenId}:${payload.receivedAt}`,
            kind: DOMAIN_JOB_KIND.MetadataRefresh,
            queue: QUEUE_NAMES.MetadataRefresh,
            payload: {
                chainId: metadataRefresh.chainId,
                contract: metadataRefresh.contract,
                tokenId: metadataRefresh.tokenId,
                metadataUrl: metadataRefresh.metadataUrl,
                reason: metadataRefresh.reason,
                source: metadataRefresh.source,
            },
            attempt: 0,
            scheduledAt: Date.now(),
            chainId: metadataRefresh.chainId,
            traceId: payload.source ?? payload.receivedAt.toString(),
        };
        await queue.publish(QUEUE_NAMES.MetadataRefresh, refreshJob);

        logger.debug("Offchain metadata refresh normalized", {
            component: "OffchainIngestWorker",
            action: "normalize",
            source: metadataRefresh.source,
            contract: metadataRefresh.contract,
            tokenId: metadataRefresh.tokenId,
            chainId: metadataRefresh.chainId,
        });
        return true;
    }

    // Unsupported offchain event types are ignored (no retry).
    logger.debug("Offchain order ignored", {
        component: "OffchainIngestWorker",
        action: "normalize",
        source: payload.source,
        chainId: payload.chainId,
    });
    return false;
}
