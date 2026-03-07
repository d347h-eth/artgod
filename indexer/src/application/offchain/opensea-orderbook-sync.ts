import { logger } from "@artgod/shared/utils";
import type { CollectionRecord } from "../../domain/collections.js";
import type { OpenSeaOrderbookRunKind } from "../../domain/opensea-jobs.js";
import type { OffchainObservationPort } from "../../ports/offchain-observations.js";
import type { QueuePort } from "../../ports/queue.js";
import type { TokenSetRegistryPort } from "../../ports/token-sets.js";
import { dispatchOffchainPayload } from "./dispatch.js";

type OpenSeaSyntheticEvent = {
    eventType: string;
    orderId: string;
    sourceEventAt: number | null;
    payload: Record<string, unknown>;
};

type OpenSeaOrderbookApiPort = {
    forEachListing(
        collectionSlug: string,
        contractAddress: string,
        handler: (event: OpenSeaSyntheticEvent) => Promise<void>,
    ): Promise<void>;
    forEachOffer(
        collectionSlug: string,
        contractAddress: string,
        handler: (event: OpenSeaSyntheticEvent) => Promise<void>,
    ): Promise<void>;
};

type OrderSourceStatePort = {
    markMissingOrdersInactive(
        chainId: number,
        source: string,
        contract: string,
        activeOrderIds: Iterable<string>,
    ): number;
};

export class OpenSeaOrderbookSync {
    constructor(
        private readonly api: OpenSeaOrderbookApiPort,
        private readonly queue: QueuePort,
        private readonly tokenSets: TokenSetRegistryPort,
        private readonly observations: OffchainObservationPort,
        private readonly sourceState: OrderSourceStatePort,
    ) {}

    async syncCollection(
        collection: CollectionRecord,
        kind: OpenSeaOrderbookRunKind,
        runId: number,
    ): Promise<{ activeOrderIds: string[]; deactivatedOrders: number }> {
        if (!collection.openseaSlug) {
            throw new Error(
                `Collection ${collection.id} missing OpenSea slug for ${kind}`,
            );
        }

        const activeOrderIds: string[] = [];
        await this.api.forEachListing(
            collection.openseaSlug,
            collection.address,
            async (event) => {
                const orderId = await this.processSyntheticEvent(
                    collection,
                    kind,
                    runId,
                    event,
                );
                if (orderId) activeOrderIds.push(orderId);
            },
        );
        await this.api.forEachOffer(
            collection.openseaSlug,
            collection.address,
            async (event) => {
                const orderId = await this.processSyntheticEvent(
                    collection,
                    kind,
                    runId,
                    event,
                );
                if (orderId) activeOrderIds.push(orderId);
            },
        );

        const deactivatedOrders = this.sourceState.markMissingOrdersInactive(
            collection.chainId,
            "opensea",
            collection.address.toLowerCase(),
            activeOrderIds,
        );

        logger.info("OpenSea orderbook sync applied", {
            component: "OpenSeaOrderbookSync",
            action: "syncCollection",
            chainId: collection.chainId,
            collectionId: collection.id,
            kind,
            runId,
            activeOrders: activeOrderIds.length,
            deactivatedOrders,
        });

        return { activeOrderIds, deactivatedOrders };
    }

    private async processSyntheticEvent(
        collection: CollectionRecord,
        kind: OpenSeaOrderbookRunKind,
        runId: number,
        event: OpenSeaSyntheticEvent,
    ): Promise<string | null> {
        const channel = kind === "snapshot" ? "snapshot" : "reconcile";
        const receivedAt = Date.now();
        const payload = {
            source: "opensea",
            chainId: collection.chainId,
            collectionId: collection.id,
            receivedAt,
            channel,
            dedupeKey: `${channel}:${runId}:${event.orderId}`,
            eventType: event.eventType,
            orderId: event.orderId,
            runId,
            sourceEventAt: event.sourceEventAt,
            payload: event.payload,
        } as const;

        this.observations.recordObservation(payload);
        const result = await dispatchOffchainPayload(
            this.queue,
            this.tokenSets,
            payload,
        );
        return result.upsertedOrderId;
    }
}
