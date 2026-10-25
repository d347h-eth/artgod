import type { CollectionRecord } from "../../domain/collections.js";
import type { CollectionRegistryPort } from "../../ports/collections.js";
import type { QueuePort } from "../../ports/queue.js";
import {
    OFFCHAIN_OBSERVATION_CHANNEL,
    OFFCHAIN_JOB_KIND,
    OFFCHAIN_ORDER_SOURCE,
    type OffchainOrderRawPayload,
} from "../../domain/offchain-jobs.js";
import type { JobEnvelope } from "../../domain/jobs.js";
import { QUEUE_NAMES } from "../../domain/queues.js";
import {
    getOpenSeaEventContract,
    getOpenSeaEventType,
    getOpenSeaOrderId,
    getOpenSeaSourceEventAt,
} from "@artgod/shared/opensea/payload";
import { getOpenSeaStreamDedupeKey } from "./opensea-stream-identity.js";

export async function publishOpenSeaStreamEvent(
    queue: Pick<QueuePort, "publish">,
    collections: Pick<
        CollectionRegistryPort,
        "getCollection" | "touchOpenSeaStreamEvent"
    >,
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

    for (const routed of scopedCollections) {
        // Subscription routing is only a hint: pause, purge or bootstrap may
        // have changed the collection since the last subscription refresh.
        const collection = collections.getCollection(routed.chainId, routed.id);
        if (
            !collection?.allowsOpenSeaStreamIngestion() ||
            collection.openseaSlug !== slug
        )
            continue;
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
            dedupeKey: getOpenSeaStreamDedupeKey(rawEvent, receivedAt),
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
