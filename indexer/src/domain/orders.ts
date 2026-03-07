export const ORDER_STATUS = {
    Fillable: "fillable",
    Filled: "filled",
    Cancelled: "cancelled",
    Expired: "expired",
    NoBalance: "no-balance",
    NoApproval: "no-approval",
    Invalid: "invalid",
} as const;

export type OrderStatus = (typeof ORDER_STATUS)[keyof typeof ORDER_STATUS];

export const ORDER_SOURCE_STATUS = {
    Active: "active",
    Inactive: "inactive",
    Cancelled: "cancelled",
    Filled: "filled",
    Invalidated: "invalidated",
    Expired: "expired",
    Unknown: "unknown",
} as const;

export type OrderSourceStatus =
    (typeof ORDER_SOURCE_STATUS)[keyof typeof ORDER_SOURCE_STATUS];

export type OrderRecord = {
    id: string;
    chainId: number;
    kind: string;
    side?: "buy" | "sell" | null;
    source?: string | null;
    maker: string;
    taker?: string | null;
    contract: string;
    tokenId?: string | null;
    tokenSetId?: string | null;
    tokenSetSchemaHash?: string | null;
    price?: string | null;
    currency?: string | null;
    validFrom?: number | null;
    validUntil?: number | null;
    fillabilityStatus: OrderStatus;
    sourceStatus: OrderSourceStatus;
    rawData?: string | null;
    blockNumber?: number | null;
    txHash?: string | null;
    logIndex?: number | null;
};
