import type { OrderRecord, OrderStatus } from "../domain/orders.js";

export type OrderValidationResult = { status: OrderStatus; reason: string };
export type OrderValidator = (
    order: OrderRecord,
) => Promise<OrderValidationResult>;

/** Results must not be persisted until finish verifies the bounded chain snapshot. */
export interface MakerValidationBatch {
    canAccept(): boolean;
    validate: OrderValidator;
    finish(): Promise<void>;
}

export type MakerValidationBatchFactory = (input: {
    chainId: number;
    minimumBlock: number | null;
}) => Promise<MakerValidationBatch>;
