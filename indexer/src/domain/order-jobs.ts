export const ORDER_JOB_KIND = {
    UpdateByMaker: "orders.update-by-maker",
    UpdateById: "orders.update-by-id",
} as const;

// Maker update = fillability changed (balance/approval/ownership), re-validate orders.
export type OrderUpdateByMakerPayload = {
    maker: string;
    contract?: string;
    tokenId?: string;
    reason: string;
    blockNumber: number;
    blockHash: string;
    txHash: string;
    logIndex: number;
};

// Order update by id = explicit fill/cancel/on-chain order create for a single order.
export type OrderUpdateByIdPayload = {
    orderId: string;
    reason: string;
    blockNumber: number;
    blockHash: string;
    txHash: string;
    logIndex: number;
};
