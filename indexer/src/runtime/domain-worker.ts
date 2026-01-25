import { createMigrationRunner } from "@artgod/shared/migrations";
import { logger } from "@artgod/shared/utils";
import { loadConfig } from "../config/index.js";
import { runWorker } from "../application/worker-runner.js";
import type { JobEnvelope } from "../domain/jobs.js";
import { NatsJetStreamQueue } from "../infra/queue/nats.js";
import {
    DOMAIN_JOB_KIND,
    type DomainSyncPayload,
} from "../domain/domain-jobs.js";
import { QUEUE_NAMES } from "../domain/queues.js";
import { SqliteOrdersDomain } from "../infra/domain/orders.js";
import type { DomainSyncContext } from "../ports/domain-handlers.js";
import { SqliteMetadataDomain } from "../infra/domain/metadata.js";
import { HttpMetadataFetcher } from "../infra/metadata/http-fetcher.js";
import { ViemTokenUriResolver } from "../infra/metadata/viem-token-uri.js";
import { noopMetrics } from "../metrics/noop.js";
import { SqliteActivityDomain } from "../infra/domain/activities.js";
import {
    ORDER_JOB_KIND,
    type OrderUpdateByIdPayload,
    type OrderUpdateByMakerPayload,
    type OrderUpsertPayload,
} from "../domain/order-jobs.js";

async function main() {
    try {
        const config = loadConfig();
        const migrations = createMigrationRunner();
        await migrations.runMigrations();
        const queue = await NatsJetStreamQueue.connect({
            natsUrl: config.queue.natsUrl,
            streamPrefix: config.queue.streamPrefix,
        });
        const ordersDomain = new SqliteOrdersDomain();
        const metadataResolver = new ViemTokenUriResolver({
            url: config.rpc.primaryUrl,
            metrics: noopMetrics,
        });
        const metadataFetcher = new HttpMetadataFetcher({
            metrics: noopMetrics,
        });
        const metadataDomain = new SqliteMetadataDomain(
            metadataResolver,
            metadataFetcher,
        );
        const activityDomain = new SqliteActivityDomain();

        const stopOrders = await runWorker(
            queue,
            {
                queue: QUEUE_NAMES.OrdersDomain,
                consumerName: `orders-domain-${config.chainId}`,
                maxInFlight: 1,
                maxAttempts: 5,
                deadLetterQueue: QUEUE_NAMES.DeadLetter,
            },
            async (job: JobEnvelope<DomainSyncPayload>) => {
                if (job.kind !== DOMAIN_JOB_KIND.OrdersSync) return;
                await ordersDomain.handleDomainSync(toDomainContext(job));
            },
        );

        const stopOrderUpdatesByMaker = await runWorker(
            queue,
            {
                queue: QUEUE_NAMES.OrdersUpdateByMaker,
                consumerName: `orders-update-by-maker-${config.chainId}`,
                maxInFlight: 1,
                maxAttempts: 5,
                deadLetterQueue: QUEUE_NAMES.DeadLetter,
            },
            async (job: JobEnvelope<OrderUpdateByMakerPayload>) => {
                if (job.kind !== ORDER_JOB_KIND.UpdateByMaker) return;
                await ordersDomain.handleOrderUpdateByMaker(job.payload);
            },
        );

        const stopOrderUpdatesById = await runWorker(
            queue,
            {
                queue: QUEUE_NAMES.OrdersUpdateById,
                consumerName: `orders-update-by-id-${config.chainId}`,
                maxInFlight: 1,
                maxAttempts: 5,
                deadLetterQueue: QUEUE_NAMES.DeadLetter,
            },
            async (job: JobEnvelope<OrderUpdateByIdPayload>) => {
                if (job.kind !== ORDER_JOB_KIND.UpdateById) return;
                await ordersDomain.handleOrderUpdateById(job.payload);
            },
        );

        const stopOrderUpserts = await runWorker(
            queue,
            {
                queue: QUEUE_NAMES.OrdersUpsert,
                consumerName: `orders-upsert-${config.chainId}`,
                maxInFlight: 1,
                maxAttempts: 5,
                deadLetterQueue: QUEUE_NAMES.DeadLetter,
            },
            async (job: JobEnvelope<OrderUpsertPayload>) => {
                if (job.kind !== ORDER_JOB_KIND.Upsert) return;
                await ordersDomain.handleOrderUpsert(job.payload);
            },
        );

        const stopMetadata = await runWorker(
            queue,
            {
                queue: QUEUE_NAMES.MetadataDomain,
                consumerName: `metadata-domain-${config.chainId}`,
                maxInFlight: 1,
                maxAttempts: 5,
                deadLetterQueue: QUEUE_NAMES.DeadLetter,
            },
            async (job: JobEnvelope<DomainSyncPayload>) => {
                if (job.kind !== DOMAIN_JOB_KIND.MetadataSync) return;
                await metadataDomain.handleDomainSync(toDomainContext(job));
            },
        );

        const stopActivity = await runWorker(
            queue,
            {
                queue: QUEUE_NAMES.ActivityDomain,
                consumerName: `activity-domain-${config.chainId}`,
                maxInFlight: 1,
                maxAttempts: 5,
                deadLetterQueue: QUEUE_NAMES.DeadLetter,
            },
            async (job: JobEnvelope<DomainSyncPayload>) => {
                if (job.kind !== DOMAIN_JOB_KIND.ActivitySync) return;
                await activityDomain.handleDomainSync(toDomainContext(job));
            },
        );

        logger.info("Domain worker ready", {
            component: "IndexerDomainWorker",
            action: "main",
        });

        const shutdown = async () => {
            logger.info("Domain worker shutting down", {
                component: "IndexerDomainWorker",
                action: "shutdown",
            });
            await stopOrders();
            await stopOrderUpdatesByMaker();
            await stopOrderUpdatesById();
            await stopOrderUpserts();
            await stopMetadata();
            await stopActivity();
            await queue.close();
            process.exit(0);
        };

        process.on("SIGINT", shutdown);
        process.on("SIGTERM", shutdown);
        process.stdin.resume();
    } catch (error) {
        logger.error("Domain worker startup failed", {
            component: "IndexerDomainWorker",
            action: "main",
            error: String(error),
        });
        process.exit(1);
    }
}

main();

function toDomainContext(
    job: JobEnvelope<DomainSyncPayload>,
): DomainSyncContext {
    return {
        chainId: job.chainId,
        fromBlock: job.payload.fromBlock,
        toBlock: job.payload.toBlock,
        mode: job.payload.mode,
        sourceJobId: job.payload.sourceJobId,
        sourceKind: job.payload.sourceKind,
    };
}
