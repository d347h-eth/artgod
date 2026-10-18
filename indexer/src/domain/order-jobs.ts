import type { OrderSourceStatus } from "./orders.js";
import type { SyncWorkClass } from "@artgod/shared/types/sync-work-class";
import {
    MAKER_TRIGGER_SCOPE,
    type CollectionScopedMakerTriggerReason,
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
export const ORDER_UPDATE_REASON = {
    Validation: "order",
    SourceExecution: "source-execution",
    Fill: "fill",
    Cancel: "cancel",
} as const;
export type OrderUpdateReason =
    (typeof ORDER_UPDATE_REASON)[keyof typeof ORDER_UPDATE_REASON];
export { MAKER_TRIGGER_SCOPE };
export type OrderUpdateByMakerReason = MakerTriggerReason;

type OrderUpdateByMakerAttribution = {
    workClass?: SyncWorkClass;
    chainId: number;
    maker: string;
    blockNumber?: number | null;
    blockHash?: string | null;
    txHash?: string | null;
    logIndex?: number | null;
    /** Full original payload lets older workers conservatively process a continuation. */
    continuation?: { runId: string; step: number };
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

// Collection-scoped maker updates re-validate active sell orders in one collection.
export type CollectionScopedOrderUpdateByMakerPayload =
    OrderUpdateByMakerAttribution & {
        scope: typeof MAKER_TRIGGER_SCOPE.Collection;
        collectionId: number;
        contract?: string;
        reason: CollectionScopedMakerTriggerReason;
    };

export type GlobalOrderUpdateByMakerPayload = OrderUpdateByMakerAttribution & {
    scope: typeof MAKER_TRIGGER_SCOPE.Global;
    reason: GlobalMakerTriggerReason;
};

export type OrderUpdateByMakerPayload =
    | TokenScopedOrderUpdateByMakerPayload
    | CollectionScopedOrderUpdateByMakerPayload
    | GlobalOrderUpdateByMakerPayload;

// An order-specific update carrying a source observation, protocol fact or validation request.
export type OrderUpdateByIdPayload = {
    chainId: number;
    /** Present on source updates, including cancellation before its create arrives. */
    collectionId?: number;
    observedAt?: number;
    /** Original order expiry supplied by a source update, when available. */
    validUntil?: number | null;
    orderId: string;
    /**
     * Domain handling category from ORDER_UPDATE_REASON, not the upstream event name.
     * Without sourceStatus, runtime handling is:
     * - Validation: admit durable full validation; preserve current state until its
     *   result updates fillability and quantities.
     * - SourceExecution: inspect the retained signed terms. Full-only orders apply
     *   the source-filled observation immediately, without RPC. Partial or unknown
     *   Seaport terms require canonical execution coverage and durable validation.
     * - Fill: apply a canonical execution. Full-only orders become filled with zero
     *   remaining capacity; partial or unknown Seaport terms require block-scoped
     *   validation to establish cumulative remaining quantity and fillability.
     * - Cancel: apply protocol cancellation.
     * With sourceStatus, the source-observation lifecycle path takes precedence:
     * apply that source status and its retention protection instead of deriving
     * protocol fillability from reason.
     * OpenSea item_sold uses SourceExecution; normalization alone cannot decide
     * whether the retained signed order permits partial fulfillment.
     */
    reason: string;
    /** Source sale inclusion to resolve before coalescing validation. Null means
     * the source omitted required evidence; never treat that as ordinary freshness. */
    executionTransactionHash?: string | null;
    sourceStatus?: OrderSourceStatus | null;
    blockNumber?: number | null;
    blockHash?: string | null;
    txHash?: string | null;
    logIndex?: number | null;
};

export type OrderUpsertPayload = {
    /** Epoch seconds of the source observation, not the queue delivery/retry time. */
    observedAt?: number;
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
    sourceEncodedTokenIds?: string | null;
    sourceSchema?: TokenSetSchema | null;
    localTokenSetStatus?: OrderLocalTokenSetStatus | null;
    tokenSetId?: string | null;
    tokenSetSchemaHash?: string | null;
    quantity?: string | null;
    originalQuantity?: string | null;
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
