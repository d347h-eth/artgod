import { logger } from "@artgod/shared/utils";
import type { CollectionRecord } from "../../domain/collections.js";
import {
    OFFCHAIN_OBSERVATION_CHANNEL,
    OFFCHAIN_JOB_KIND,
    OFFCHAIN_ORDER_SOURCE,
    type OffchainOrderRawPayload,
} from "../../domain/offchain-jobs.js";
import type { JobEnvelope } from "../../domain/jobs.js";
import type { OpenSeaOrderbookRunKind } from "../../domain/opensea-jobs.js";
import type { QueuePort } from "../../ports/queue.js";
import { QUEUE_NAMES } from "../../domain/queues.js";

type OpenSeaRestRecord = {
    eventType: string;
    orderId: string;
    sourceEventAt: number | null;
    payload: Record<string, unknown>;
};

type OpenSeaOrderbookApiPort = {
    forEachListing(
        collectionSlug: string,
        contractAddress: string,
        handler: (record: OpenSeaRestRecord) => Promise<void>,
    ): Promise<void>;
    forEachOffer(
        collectionSlug: string,
        contractAddress: string,
        handler: (record: OpenSeaRestRecord) => Promise<void>,
    ): Promise<void>;
};

export type OrderSourceObservation = {
    /** False closes producer admission after collection deletion. */
    recordActiveOrder(orderId: string): boolean;
    complete(): Promise<number>;
    close(): void;
};

export type OrderSourceStatePort = {
    beginObservation(input: {
        chainId: number;
        collectionId: number;
        source: string;
        startedAt: number;
    }): OrderSourceObservation;
};

class CollectionObservationClosed extends Error {}

export class OpenSeaOrderbookSync {
    constructor(
        private readonly api: OpenSeaOrderbookApiPort,
        private readonly queue: Pick<QueuePort, "publish">,
        private readonly sourceState: OrderSourceStatePort,
    ) {}

    async syncCollection(
        collection: CollectionRecord,
        kind: OpenSeaOrderbookRunKind,
        runId: number,
    ): Promise<{ activeOrders: number; deactivatedOrders: number }> {
        if (!collection.openseaSlug) {
            throw new Error(
                `Collection ${collection.id} missing OpenSea slug for ${kind}`,
            );
        }

        const observation = this.sourceState.beginObservation({
            chainId: collection.chainId,
            collectionId: collection.id,
            source: OFFCHAIN_ORDER_SOURCE.OpenSea,
            startedAt: Math.floor(Date.now() / 1000),
        });
        let activeOrders = 0;
        try {
            await this.api.forEachListing(
                collection.openseaSlug,
                collection.address,
                async (record) => {
                    if (!observation.recordActiveOrder(record.orderId))
                        throw new CollectionObservationClosed();
                    const orderId = await this.publishRestRecord(
                        collection,
                        kind,
                        runId,
                        record,
                    );
                    if (orderId) activeOrders++;
                },
            );
            await this.api.forEachOffer(
                collection.openseaSlug,
                collection.address,
                async (record) => {
                    if (!observation.recordActiveOrder(record.orderId))
                        throw new CollectionObservationClosed();
                    const orderId = await this.publishRestRecord(
                        collection,
                        kind,
                        runId,
                        record,
                    );
                    if (orderId) activeOrders++;
                },
            );

            const deactivatedOrders = await observation.complete();

            logger.info("OpenSea orderbook sync applied", {
                component: "OpenSeaOrderbookSync",
                action: "syncCollection",
                chainId: collection.chainId,
                collectionId: collection.id,
                kind,
                runId,
                activeOrders,
                deactivatedOrders,
            });

            return { activeOrders, deactivatedOrders };
        } catch (error) {
            if (error instanceof CollectionObservationClosed)
                return { activeOrders, deactivatedOrders: 0 };
            throw error;
        } finally {
            observation.close();
        }
    }

    private async publishRestRecord(
        collection: CollectionRecord,
        kind: OpenSeaOrderbookRunKind,
        runId: number,
        record: OpenSeaRestRecord,
    ): Promise<string | null> {
        const channel =
            kind === OFFCHAIN_OBSERVATION_CHANNEL.Snapshot
                ? OFFCHAIN_OBSERVATION_CHANNEL.Snapshot
                : OFFCHAIN_OBSERVATION_CHANNEL.Reconcile;
        const receivedAt = Date.now();
        const payload: OffchainOrderRawPayload = {
            source: OFFCHAIN_ORDER_SOURCE.OpenSea,
            chainId: collection.chainId,
            collectionId: collection.id,
            receivedAt,
            channel,
            dedupeKey: `${channel}:${runId}:${record.eventType}:${record.orderId}`,
            eventType: record.eventType,
            orderId: record.orderId,
            runId,
            sourceEventAt: record.sourceEventAt,
            payload: record.payload,
        };
        const job: JobEnvelope<OffchainOrderRawPayload> = {
            jobId: `offchain:raw:${collection.chainId}:${collection.id}:${payload.dedupeKey}`,
            kind: OFFCHAIN_JOB_KIND.OrderRaw,
            queue: QUEUE_NAMES.OffchainOrdersRaw,
            payload,
            attempt: 0,
            scheduledAt: receivedAt,
            traceId: record.orderId,
            chainId: collection.chainId,
            collectionId: collection.id,
        };
        await this.queue.publish(QUEUE_NAMES.OffchainOrdersRaw, job);
        return record.orderId;
    }
}
