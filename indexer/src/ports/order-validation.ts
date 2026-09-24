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
    /** Logical reads, including fallbacks; batches count aggregate port calls separately. */
    readCounts(): {
        perOrder: number;
        shared: number;
        other: number;
        statusBatches?: number;
    };
}

type ValidationSnapshotInput = {
    chainId: number;
    minimumBlock: number | null;
    /** Bounded lookahead only; each candidate still requires full validation before commit. */
    candidates?: readonly OrderRecord[];
};

export type MakerValidationBatchFactory = (
    input: ValidationSnapshotInput,
) => Promise<MakerValidationBatch>;

/** A full-order snapshot whose successful finish proves trigger coverage. */
export type OrderValidationSnapshotFactory = (
    input: ValidationSnapshotInput,
) => Promise<
    MakerValidationBatch & {
        proof: { observedAt: number; blockNumber: number };
    }
>;
