export type OrderSide = "sell" | "buy";

export type DecodedFillEvent = {
    orderId?: string;
    kind?: string;
    orderSide?: OrderSide;
    maker?: string;
    taker?: string;
    contract: string;
    tokenId: string;
    amount?: string;
    price?: string;
    currency?: string;
    blockNumber: number;
    blockHash: string;
    txHash: string;
    logIndex: number;
};
