import type { FillExecution } from "@artgod/shared/market-data/fills";
import type { OrderSide } from "@artgod/shared/market-data/orders";
export type { OrderSide } from "@artgod/shared/market-data/orders";

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
    execution: FillExecution;
    executionItemIndex: number;
    blockNumber: number;
    blockHash: string;
    txHash: string;
    logIndex: number;
};
