export const OFFCHAIN_JOB_KIND = {
    OrderRaw: "offchain.order.raw",
} as const;

// Names raw offchain payload producers recognized by normalizers and workers.
export const OFFCHAIN_ORDER_SOURCE = {
    OpenSea: "opensea",
} as const;

export type OffchainOrderSource =
    (typeof OFFCHAIN_ORDER_SOURCE)[keyof typeof OFFCHAIN_ORDER_SOURCE];

// Names raw observation lanes that feed offchain order normalization.
export const OFFCHAIN_OBSERVATION_CHANNEL = {
    Stream: "stream",
    Snapshot: "snapshot",
    Reconcile: "reconcile",
} as const;

export type OffchainObservationChannel =
    (typeof OFFCHAIN_OBSERVATION_CHANNEL)[keyof typeof OFFCHAIN_OBSERVATION_CHANNEL];

// Event types emitted by OpenSea REST snapshot/reconcile adapters.
export const OPENSEA_REST_EVENT_TYPE = {
    Listing: "rest.listing",
    ItemOffer: "rest.offer.item",
    CollectionOffer: "rest.offer.collection",
    TraitOffer: "rest.offer.trait",
} as const;

export type OpenSeaRestEventType =
    (typeof OPENSEA_REST_EVENT_TYPE)[keyof typeof OPENSEA_REST_EVENT_TYPE];

export type OffchainOrderRawPayload = {
    source: string;
    chainId: number;
    collectionId: number;
    receivedAt: number;
    channel: OffchainObservationChannel;
    dedupeKey: string;
    eventType: string;
    orderId?: string | null;
    runId?: number | null;
    sourceEventAt?: number | null;
    payload: unknown;
};
