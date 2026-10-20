import type { ValidationCheckpoint } from "../domain/chain-sync.js";
import type { OrderValidationProof } from "../domain/order-validation-demand.js";
import type { OrderRecord, OrderValidationResult } from "../domain/orders.js";
import type { SyncWorkClass } from "@artgod/shared/types/sync-work-class";
export type { OrderValidationResult } from "../domain/orders.js";
export type OrderValidator = (
    order: OrderRecord,
) => Promise<OrderValidationResult>;

/** Results must not be persisted until finish verifies the bounded chain snapshot. */
export interface OrderValidationSnapshot {
    readonly proof: OrderValidationProof;
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
    /** Supplied by the chain coordinator after essential state is applied. */
    checkpoint: ValidationCheckpoint;
    workClass?: SyncWorkClass;
    /** Bounded lookahead only; each candidate still requires full validation before commit. */
    candidates?: readonly OrderRecord[];
};

/** A bounded full-order snapshot selected by the applied chain owner. */
export type OrderValidationSnapshotFactory = (
    input: ValidationSnapshotInput,
) => Promise<OrderValidationSnapshot>;
