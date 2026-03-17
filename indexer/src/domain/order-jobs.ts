import type { OrderSourceStatus } from "./orders.js";
import {
    MAKER_TRIGGER_SCOPE,
    type GlobalMakerTriggerReason,
    type MakerTriggerReason,
    type TokenScopedMakerTriggerReason,
} from "./maker-triggers.js";
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
export { MAKER_TRIGGER_SCOPE };
export type OrderUpdateByMakerReason = MakerTriggerReason;

type OrderUpdateByMakerAttribution = {
    chainId: number;
    maker: string;
    blockNumber?: number | null;
    blockHash?: string | null;
    txHash?: string | null;
    logIndex?: number | null;
};

// Maker update = fillability changed (balance/approval/ownership), re-validate orders.
export type TokenScopedOrderUpdateByMakerPayload =
    OrderUpdateByMakerAttribution & {
        scope: typeof MAKER_TRIGGER_SCOPE.Token;
        collectionId: number;
        tokenId: string;
        contract?: string;
        reason: TokenScopedMakerTriggerReason;
    };

export type GlobalOrderUpdateByMakerPayload = OrderUpdateByMakerAttribution & {
    scope: typeof MAKER_TRIGGER_SCOPE.Global;
    reason: GlobalMakerTriggerReason;
};

export type OrderUpdateByMakerPayload =
    | TokenScopedOrderUpdateByMakerPayload
    | GlobalOrderUpdateByMakerPayload;

// Order update by id = explicit fill/cancel/on-chain order create for a single order.
export type OrderUpdateByIdPayload = {
    chainId: number;
    orderId: string;
    reason: string;
    sourceStatus?: OrderSourceStatus | null;
    blockNumber?: number | null;
    blockHash?: string | null;
    txHash?: string | null;
    logIndex?: number | null;
};

export type OrderUpsertPayload = {
    chainId: number;
    collectionId: number;
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
