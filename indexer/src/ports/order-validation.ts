import type { OrderRecord, OrderValidationResult } from "../domain/orders.js";
export type { OrderValidationResult } from "../domain/orders.js";
export type OrderValidator = (
    order: OrderRecord,
) => Promise<OrderValidationResult>;

/** Results must not be persisted until finish verifies the bounded chain snapshot. */
export interface MakerValidationBatch {
    canAccept(): boolean;
    validate: OrderValidator;
    finish(): Promise<void>;
    /** Contract-read port calls, excluding transport retries and block lookups. */
    readCounts(): { perOrder: number; shared: number; other: number };
}

export type MakerValidationBatchFactory = (input: {
    chainId: number;
    minimumBlock: number | null;
}) => Promise<MakerValidationBatch>;

/** A full-order snapshot whose successful finish proves trigger coverage. */
export type OrderValidationSnapshotFactory = (input: {
    chainId: number;
    minimumBlock: number | null;
}) => Promise<
    MakerValidationBatch & {
        proof: { observedAt: number; blockNumber: number };
    }
>;
