import {
    EventType,
    LogLevel,
    Network,
    OpenSeaStreamClient,
} from "@opensea/stream-js";

export const OPENSEA_STREAM_EVENT_TYPES = [
    EventType.ITEM_METADATA_UPDATED,
    EventType.ITEM_LISTED,
    EventType.ITEM_SOLD,
    EventType.ITEM_TRANSFERRED,
    EventType.ITEM_RECEIVED_OFFER,
    EventType.ITEM_RECEIVED_BID,
    EventType.ITEM_CANCELLED,
    EventType.COLLECTION_OFFER,
    EventType.TRAIT_OFFER,
    EventType.ORDER_INVALIDATE,
    EventType.ORDER_REVALIDATE,
] as const;

export class OpenSeaStreamAdapter {
    private readonly client: OpenSeaStreamClient;

    constructor(apiKey: string) {
        this.client = new OpenSeaStreamClient({
            token: apiKey,
            network: Network.MAINNET,
            logLevel: LogLevel.ERROR,
        });
    }

    subscribe(
        collectionSlug: string,
        handler: (event: unknown) => void,
    ): () => void {
        return this.client.onEvents(
            collectionSlug,
            [...OPENSEA_STREAM_EVENT_TYPES],
            handler,
        );
    }

    disconnect(): void {
        this.client.disconnect();
    }
}
