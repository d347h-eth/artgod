import type { OrderSourceStatus } from "./orders.js";
import type {
    OrderLocalTokenSetStatus,
    SeaportOrderData,
    OrderSourceScopeKind,
} from "./orders.js";
import type { TokenSetSchema } from "./token-sets.js";

export const ORDER_JOB_KIND = {
    UpdateByMaker: "orders.update-by-maker",
    UpdateById: "orders.update-by-id",
    Upsert: "orders.upsert",
} as const;

export type OrderUpdateByMakerReason =
    | "nft-transfer"
    | "erc20-balance"
    | "approval-change"
    | "order-counter"
    | "item_sold"
    | "item_transferred";

// Maker update = fillability changed (balance/approval/ownership), re-validate orders.
export type OrderUpdateByMakerPayload = {
    chainId: number;
    maker: string;
    contract?: string;
    tokenId?: string;
    reason: OrderUpdateByMakerReason;
    blockNumber: number;
    blockHash: string;
    txHash: string;
    logIndex: number;
};

// Order update by id = explicit fill/cancel/on-chain order create for a single order.
export type OrderUpdateByIdPayload = {
    chainId: number;
    orderId: string;
    reason: string;
    sourceStatus?: OrderSourceStatus | null;
    blockNumber: number;
    blockHash: string;
    txHash: string;
    logIndex: number;
};

export type OrderUpsertPayload = {
    chainId: number;
    orderId: string;
    kind: string;
    side: "buy" | "sell";
    maker: string;
    taker?: string | null;
    contract: string;
    tokenId?: string | null;
    sourceScopeKind: OrderSourceScopeKind;
    sourceCriteriaRoot?: string | null;
    sourceSchema?: TokenSetSchema | null;
    localTokenSetStatus?: OrderLocalTokenSetStatus | null;
    tokenSetId?: string | null;
    tokenSetSchemaHash?: string | null;
    price?: string | null;
    currency?: string | null;
    validFrom?: number | null;
    validUntil?: number | null;
    source: string;
    sourceStatus?: OrderSourceStatus | null;
    rawSourceKind: "stream" | "rest";
    rawPayload?: unknown;
    seaportData?: SeaportOrderData | null;
    // validateAfterUpsert is expected to be "true" by default to trigger onchain validation of the order,
    // otherwise the order might be persisted optimistically as "fillable".
    validateAfterUpsert: boolean;
};
