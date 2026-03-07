import type { OffchainObservationChannel } from "../domain/offchain-jobs.js";

export type OffchainObservationInput = {
    chainId: number;
    collectionId: number;
    source: string;
    channel: OffchainObservationChannel;
    dedupeKey: string;
    eventType: string;
    orderId?: string | null;
    runId?: number | null;
    receivedAt: number;
    sourceEventAt?: number | null;
    payload: unknown;
};

export interface OffchainObservationPort {
    recordObservation(input: OffchainObservationInput): void;
}
