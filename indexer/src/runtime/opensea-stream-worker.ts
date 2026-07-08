import { createMigrationRunner } from "@artgod/shared/migrations";
import { setDbPath } from "@artgod/shared/database";
import { logger } from "@artgod/shared/utils";
import { loadOpenSeaConfig } from "../config/opensea.js";
import type { CollectionRecord } from "../domain/collections.js";
import {
    OFFCHAIN_OBSERVATION_CHANNEL,
    OFFCHAIN_JOB_KIND,
    OFFCHAIN_ORDER_SOURCE,
    type OffchainOrderRawPayload,
} from "../domain/offchain-jobs.js";
import type { JobEnvelope } from "../domain/jobs.js";
import { QUEUE_NAMES } from "../domain/queues.js";
import {
    getOpenSeaEventContract,
    getOpenSeaEventType,
    getOpenSeaOrderId,
    getOpenSeaSourceEventAt,
} from "../application/offchain/opensea-envelope.js";
import { SqliteCollectionRegistry } from "../infra/collections/sqlite.js";
import { OpenSeaStreamAdapter } from "../infra/offchain/opensea-stream.js";
import { NatsJetStreamQueue } from "../infra/queue/nats.js";
import { initRuntimeMetrics } from "@artgod/shared/observability/metrics";
import { initRuntimeApm } from "@artgod/shared/observability/apm";

type SubscriptionRecord = {
    unsubscribe: () => void;
    collectionIds: number[];
};

async function main() {
    try {
        const config = loadOpenSeaConfig();
        setDbPath(config.dbPath);
        const runtimeApm = await initRuntimeApm({
            enabled: config.apm.enabled,
            serviceNamespace: config.apm.serviceNamespace,
            spanProfiles: config.apm.spanProfiles,
            worker: "opensea-stream-worker",
            chainId: config.chainId,
            traces: config.apm.traces,
            profiles: config.apm.profiles,
        });
        const runtimeMetrics = await initRuntimeMetrics({
            enabled: config.metrics.enabled,
            host: config.metrics.host,
            port: config.metrics.ports.streamWorker,
            worker: "opensea-stream-worker",
            chainId: config.chainId,
        });
        const migrations = createMigrationRunner();
        await migrations.runMigrations();
        const queue = await NatsJetStreamQueue.connect({
            natsUrl: config.queue.natsUrl,
            streamPrefix: config.queue.streamPrefix,
        });
        const collections = new SqliteCollectionRegistry();
        const stream = new OpenSeaStreamAdapter(config.opensea.apiKey);

        const subscriptions = new Map<string, SubscriptionRecord>();
        let routedCollections = new Map<string, CollectionRecord[]>();
        let stopped = false;

        const syncSubscriptions = async () => {
            if (stopped) return;

            const tracked = collections.listCollectionsForOpenSeaSubscription(
                config.chainId,
            );
            routedCollections = groupCollectionsBySlug(tracked);

            const desiredSlugs = new Set(routedCollections.keys());

            for (const [slug, record] of subscriptions) {
                if (desiredSlugs.has(slug)) continue;
                record.unsubscribe();
                subscriptions.delete(slug);
            }

            for (const [slug, scopedCollections] of routedCollections) {
                const existing = subscriptions.get(slug);
                if (!existing) {
                    const unsubscribe = stream.subscribe(slug, (event) => {
                        handleOpenSeaEvent(
                            queue,
                            collections,
                            slug,
                            routedCollections,
                            event,
                        ).catch((error) => {
                            logger.warn(
                                "OpenSea stream event handling failed",
                                {
                                    component: "OpenSeaStreamWorker",
                                    action: "handleEvent",
                                    slug,
                                    error: String(error),
                                },
                            );
                        });
                    });
                    subscriptions.set(slug, {
                        unsubscribe,
                        collectionIds: scopedCollections.map(
                            (collection) => collection.id,
                        ),
                    });
                } else {
                    existing.collectionIds = scopedCollections.map(
                        (collection) => collection.id,
                    );
                }

                for (const collection of scopedCollections) {
                    collections.touchOpenSeaStreamHealthy(
                        collection.chainId,
                        collection.id,
                    );
                }
            }
        };

        await syncSubscriptions();
        const timer = setInterval(() => {
            syncSubscriptions().catch((error) => {
                logger.warn("OpenSea subscription sync failed", {
                    component: "OpenSeaStreamWorker",
                    action: "syncSubscriptions",
                    error: String(error),
                });
            });
        }, config.opensea.subscriptionPollMs);

        logger.info("OpenSea stream worker ready", {
            component: "OpenSeaStreamWorker",
            action: "main",
        });

        const shutdown = async () => {
            stopped = true;
            logger.info("OpenSea stream worker shutting down", {
                component: "OpenSeaStreamWorker",
                action: "shutdown",
            });
            clearInterval(timer);
            for (const { unsubscribe } of subscriptions.values()) {
                unsubscribe();
            }
            stream.disconnect();
            await runtimeApm.stop();
            await runtimeMetrics.stop();
            await queue.close();
            process.exit(0);
        };

        process.on("SIGINT", shutdown);
        process.on("SIGTERM", shutdown);
    } catch (error) {
        logger.error("OpenSea stream worker failed", {
            component: "OpenSeaStreamWorker",
            action: "main",
            error: String(error),
        });
        process.exit(1);
    }
}

main();

async function handleOpenSeaEvent(
    queue: NatsJetStreamQueue,
    collections: SqliteCollectionRegistry,
    slug: string,
    routedCollections: Map<string, CollectionRecord[]>,
    rawEvent: unknown,
): Promise<void> {
    const eventType = getOpenSeaEventType(rawEvent);
    if (!eventType) return;

    const contract = getOpenSeaEventContract(rawEvent);
    const scopedCollections = routedCollections.get(slug) ?? [];

    if (scopedCollections.length === 0) {
        return;
    }

    for (const collection of scopedCollections) {
        if (contract && collection.address.toLowerCase() !== contract) {
            continue;
        }
        const receivedAt = Date.now();
        const orderId = getOpenSeaOrderId(rawEvent);
        const rawPayload: OffchainOrderRawPayload = {
            source: OFFCHAIN_ORDER_SOURCE.OpenSea,
            chainId: collection.chainId,
            collectionId: collection.id,
            receivedAt,
            channel: OFFCHAIN_OBSERVATION_CHANNEL.Stream,
            dedupeKey: `${OFFCHAIN_OBSERVATION_CHANNEL.Stream}:${eventType}:${orderId ?? "na"}:${getOpenSeaSourceEventAt(rawEvent) ?? receivedAt}`,
            eventType,
            orderId,
            runId: null,
            sourceEventAt: getOpenSeaSourceEventAt(rawEvent),
            payload: rawEvent,
        };
        const job: JobEnvelope<OffchainOrderRawPayload> = {
            jobId: `offchain:raw:${collection.chainId}:${collection.id}:${rawPayload.dedupeKey}`,
            kind: OFFCHAIN_JOB_KIND.OrderRaw,
            queue: QUEUE_NAMES.OffchainOrdersRaw,
            payload: rawPayload,
            attempt: 0,
            scheduledAt: receivedAt,
            traceId: orderId ?? rawPayload.dedupeKey,
            chainId: collection.chainId,
            collectionId: collection.id,
        };
        await queue.publish(QUEUE_NAMES.OffchainOrdersRaw, job);
        collections.touchOpenSeaStreamEvent(collection.chainId, collection.id);
    }
}

function groupCollectionsBySlug(
    collections: CollectionRecord[],
): Map<string, CollectionRecord[]> {
    const grouped = new Map<string, CollectionRecord[]>();
    for (const collection of collections) {
        if (!collection.openseaSlug) continue;
        const key = collection.openseaSlug;
        const existing = grouped.get(key);
        if (existing) {
            existing.push(collection);
        } else {
            grouped.set(key, [collection]);
        }
    }
    return grouped;
}
