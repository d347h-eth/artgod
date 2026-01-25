export const ORDER_STATUS = {
    Fillable: "fillable",
    Filled: "filled",
    Cancelled: "cancelled",
    Expired: "expired",
    NoBalance: "no-balance",
} as const;

export type OrderStatus = (typeof ORDER_STATUS)[keyof typeof ORDER_STATUS];

export type OrderRecord = {
    id: string;
    chainId: number;
    kind: string;
    side?: "buy" | "sell" | null;
    source?: string | null;
    maker: string;
    taker?: string | null;
    contract: string;
    tokenId: string;
    price?: string | null;
    currency?: string | null;
    validFrom?: number | null;
    validUntil?: number | null;
    fillabilityStatus: OrderStatus;
    rawData?: string | null;
    blockNumber?: number | null;
    txHash?: string | null;
    logIndex?: number | null;
};
