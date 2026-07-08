import type { CollectionRecord } from "../../domain/collections.js";
import {
    OFFCHAIN_OBSERVATION_CHANNEL,
    OFFCHAIN_ORDER_SOURCE,
    type OffchainOrderRawPayload,
} from "../../domain/offchain-jobs.js";

export type OffchainIngestionCollectionLookupPort = {
    getCollection(chainId: number, collectionId: number): CollectionRecord | null;
};

// Checks whether a raw offchain payload may be normalized into downstream jobs.
export function shouldProcessOffchainPayload(
    collections: OffchainIngestionCollectionLookupPort,
    payload: OffchainOrderRawPayload,
): boolean {
    if (
        payload.source !== OFFCHAIN_ORDER_SOURCE.OpenSea ||
        payload.channel !== OFFCHAIN_OBSERVATION_CHANNEL.Stream
    ) {
        return true;
    }

    const collection = collections.getCollection(
        payload.chainId,
        payload.collectionId,
    );
    return collection?.allowsOpenSeaStreamIngestion() ?? true;
}
