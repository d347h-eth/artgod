import type { BookPublicationPort } from "../../ports/orderbooks.js";
import {
    ORDERBOOK_VENUE,
    ORDER_SOURCE_STATUS,
} from "@artgod/shared/market-data/orders";
import {
    BOOK_VIEW,
    type BookFeed,
    type BookObservation,
} from "../../domain/orderbook.js";
import {
    OFFCHAIN_OBSERVATION_CHANNEL,
    type OffchainOrderRawPayload,
} from "../../domain/offchain-jobs.js";
import type { CollectionRegistryPort } from "../../ports/collections.js";
import {
    normalizeOffchainOrder,
    normalizeOffchainOrderUpdateById,
} from "./normalize.js";
import { openSeaFeed, openSeaObservation } from "./opensea-orderbook-sync.js";

export class OpenSeaStreamBook {
    constructor(
        private readonly collections: Pick<
            CollectionRegistryPort,
            "getCollection"
        >,
        private readonly store: Pick<BookPublicationPort, "begin" | "bind"> & {
            acceptsStream(
                feed: BookFeed,
                received: number,
                sourceTime?: number | null,
            ): boolean;
            previousObservation(
                feed: BookFeed,
                id: string,
            ): BookObservation | undefined;
        },
    ) {}
    async observe(raw: OffchainOrderRawPayload) {
        if (
            raw.source !== ORDERBOOK_VENUE.OpenSea ||
            raw.channel !== OFFCHAIN_OBSERVATION_CHANNEL.Stream ||
            !raw.market
        )
            return false;
        const collection = this.collections.getCollection(
            raw.chainId,
            raw.collectionId,
        );
        if (
            !collection?.allowsOpenSeaStreamIngestion() ||
            collection.openseaSlug !== raw.market
        )
            return false;
        const feed = openSeaFeed(collection, BOOK_VIEW.Stream);
        const update = normalizeOffchainOrderUpdateById(raw);
        const normalized = normalizeOffchainOrder(raw);
        const id = normalized?.orderId ?? update?.orderId;
        const sourceTime =
            raw.sourceEventAt == null ? null : raw.sourceEventAt * 1000;
        if (!id || !this.store.acceptsStream(feed, raw.receivedAt, sourceTime))
            return false;
        // A status-only event can restore or withdraw previously verified terms.
        // It cannot authenticate a new order on its own.
        const prior =
            update && !normalized
                ? this.store.previousObservation(feed, id)
                : undefined;
        const record = prior
            ? { ...prior, sourceTime }
            : await openSeaObservation(feed, id, normalized, sourceTime);
        if (update) {
            record.status = update.sourceStatus ?? ORDER_SOURCE_STATUS.Unknown;
            record.fillable =
                !!record.order && record.status === ORDER_SOURCE_STATUS.Active;
        }
        if (!this.store.acceptsStream(feed, raw.receivedAt, sourceTime))
            return false;
        this.store.bind(feed, collection.id);
        const read = this.store.begin(
            feed,
            { kind: "sighting" },
            raw.receivedAt,
        );
        try {
            read.record(record);
            read.publish();
            return true;
        } finally {
            read.close();
        }
    }
}
