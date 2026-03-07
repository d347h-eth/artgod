export const OFFCHAIN_JOB_KIND = {
    OrderRaw: "offchain.order.raw",
} as const;

export type OffchainObservationChannel = "stream" | "snapshot" | "reconcile";

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
