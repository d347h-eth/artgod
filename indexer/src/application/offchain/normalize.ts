import type { OffchainOrderRawPayload } from "../../domain/offchain-jobs.js";
import type { TokenScopedMakerTriggerReason } from "../../domain/maker-triggers.js";
import type {
    OrderLocalTokenSetStatus,
    SeaportOrderData,
    OrderSourceScopeKind,
    OrderSourceStatus,
} from "../../domain/orders.js";
import {
    ACTIVITY_KIND,
    ACTIVITY_SCOPE_KIND,
    type ActivityKind,
} from "../../domain/activities.js";
import type { ActivityUpsertPayload } from "../../domain/activity-jobs.js";
import type { TokenSetSchema } from "../../domain/token-sets.js";
import {
    normalizeOpenSeaEvent,
    normalizeOpenSeaMakerUpdate,
    normalizeOpenSeaMetadataRefresh,
    normalizeOpenSeaOrderUpdate,
} from "./opensea-normalize.js";
import { normalizeOpenSeaRestOrder } from "./opensea-rest-normalize.js";
import {
    asObject,
    assertAddress,
    assertSide,
    assertString,
    parseOptionalAddress,
    parseOptionalNumber,
    parseOptionalString,
} from "./normalizer-utils.js";

export type RawOrderPayload = {
    orderId: string;
    kind: string;
    side: "buy" | "sell";
    maker: string;
    taker?: string | null;
    contract: string;
    tokenId?: string | null;
    sourceScopeKind: OrderSourceScopeKind;
    sourceSchema?: TokenSetSchema | null;
    sourceCriteriaRoot?: string | null;
    localTokenSetStatus?: OrderLocalTokenSetStatus | null;
    price?: string | null;
    currency?: string | null;
    validFrom?: number | null;
    validUntil?: number | null;
    seaportData?: SeaportOrderData | null;
};

export type NormalizedOffchainOrder = RawOrderPayload & {
    chainId: number;
    source: string;
    rawSourceKind: "stream" | "rest";
    rawPayload: unknown;
};

export type NormalizedOffchainOrderUpdateById = {
    chainId: number;
    source: string;
    orderId: string;
    reason: "cancel" | "order" | "fill";
    sourceStatus: OrderSourceStatus;
};

export type NormalizedOffchainOrderUpdateByMaker = {
    chainId: number;
    source: string;
    maker: string;
    contract: string;
    tokenId: string;
    reason: TokenScopedMakerTriggerReason;
};

export type NormalizedOffchainMetadataRefresh = {
    chainId: number;
    source: string;
    contract: string;
    tokenId: string;
    metadataUrl: string | null;
    reason: "metadata_updated";
};

export type ExistingOrderActivityContext = {
    side: "buy" | "sell" | null;
    sourceScopeKind: string | null;
    contract: string;
    tokenId: string | null;
    maker: string;
    taker: string | null;
    price: string | null;
    currency: string | null;
};

export function normalizeOffchainOrder(
    raw: OffchainOrderRawPayload,
): NormalizedOffchainOrder | null {
    // Raw payloads are untrusted. Validate and normalize into a minimal
    // order shape that the orders domain can safely persist.
    if (!raw.source) {
        throw new Error("Missing offchain order source");
    }
    if (!Number.isFinite(raw.chainId)) {
        throw new Error("Invalid offchain order chainId");
    }
    if (!Number.isFinite(raw.receivedAt)) {
        throw new Error("Invalid offchain order receivedAt");
    }

    const order =
        raw.source === "opensea"
            ? normalizeOpenSeaOrderPayload(raw)
            : toRawOrderPayload(asObject(raw.payload, "payload"));
    if (!order) return null;

    return {
        chainId: raw.chainId,
        orderId: order.orderId,
        kind: order.kind,
        side: order.side,
        maker: assertAddress(order.maker, "maker"),
        taker: parseOptionalAddress(order.taker, "taker"),
        contract: assertAddress(order.contract, "contract"),
        tokenId: order.tokenId ?? null,
        sourceScopeKind: order.sourceScopeKind,
        sourceSchema: order.sourceSchema ?? null,
        sourceCriteriaRoot: order.sourceCriteriaRoot ?? null,
        localTokenSetStatus: order.localTokenSetStatus ?? null,
        price: order.price ?? null,
        currency: parseOptionalAddress(order.currency, "currency"),
        validFrom: order.validFrom ?? null,
        validUntil: order.validUntil ?? null,
        seaportData: order.seaportData ?? null,
        source: raw.source,
        rawSourceKind: raw.channel === "stream" ? "stream" : "rest",
        rawPayload: raw.payload,
    };
}

function toRawOrderPayload(value: Record<string, unknown>): RawOrderPayload {
    return {
        orderId: assertString(value.orderId, "orderId"),
        kind: assertString(value.kind, "kind"),
        side: assertSide(value.side, "side"),
        maker: assertString(value.maker, "maker"),
        taker: parseOptionalAddress(value.taker, "taker"),
        contract: assertString(value.contract, "contract"),
        tokenId: parseOptionalString(value.tokenId, "tokenId"),
        price: parseOptionalString(value.price, "price"),
        currency: parseOptionalString(value.currency, "currency"),
        sourceScopeKind: "token",
        sourceSchema: null,
        sourceCriteriaRoot: null,
        localTokenSetStatus: "none",
        validFrom: parseOptionalNumber(value.validFrom, "validFrom"),
        validUntil: parseOptionalNumber(value.validUntil, "validUntil"),
        seaportData: null,
    };
}

export function normalizeOffchainOrderUpdateById(
    raw: OffchainOrderRawPayload,
): NormalizedOffchainOrderUpdateById | null {
    if (!raw.source) {
        throw new Error("Missing offchain order source");
    }
    if (!Number.isFinite(raw.chainId)) {
        throw new Error("Invalid offchain order chainId");
    }

    if (raw.source !== "opensea" || raw.channel !== "stream") return null;
    const update = normalizeOpenSeaOrderUpdate(raw.payload);
    if (!update) return null;

    return {
        chainId: raw.chainId,
        source: raw.source,
        orderId: update.orderId,
        reason: update.reason,
        sourceStatus: update.sourceStatus,
    };
}

export function normalizeOffchainOrderUpdateByMaker(
    raw: OffchainOrderRawPayload,
): NormalizedOffchainOrderUpdateByMaker | null {
    if (!raw.source) {
        throw new Error("Missing offchain order source");
    }
    if (!Number.isFinite(raw.chainId)) {
        throw new Error("Invalid offchain order chainId");
    }

    if (raw.source !== "opensea" || raw.channel !== "stream") return null;
    const update = normalizeOpenSeaMakerUpdate(raw.payload);
    if (!update) return null;

    return {
        chainId: raw.chainId,
        source: raw.source,
        maker: update.maker,
        contract: update.contract,
        tokenId: update.tokenId,
        reason: update.reason,
    };
}

export function normalizeOffchainMetadataRefresh(
    raw: OffchainOrderRawPayload,
): NormalizedOffchainMetadataRefresh | null {
    if (!raw.source) {
        throw new Error("Missing offchain order source");
    }
    if (!Number.isFinite(raw.chainId)) {
        throw new Error("Invalid offchain order chainId");
    }

    if (raw.source !== "opensea" || raw.channel !== "stream") return null;
    const refresh = normalizeOpenSeaMetadataRefresh(raw.payload);
    if (!refresh) return null;

    return {
        chainId: raw.chainId,
        source: raw.source,
        contract: refresh.contract,
        tokenId: refresh.tokenId,
        metadataUrl: refresh.metadataUrl,
        reason: refresh.reason,
    };
}

export function normalizeOffchainActivity(
    raw: OffchainOrderRawPayload,
    existingOrder: ExistingOrderActivityContext | null,
): ActivityUpsertPayload | null {
    if (!raw.source) {
        throw new Error("Missing offchain order source");
    }
    if (!Number.isFinite(raw.chainId)) {
        throw new Error("Invalid offchain order chainId");
    }
    if (raw.source !== "opensea" || raw.channel !== "stream") return null;

    const occurredAt = raw.sourceEventAt ?? raw.receivedAt;
    if (!Number.isFinite(occurredAt)) return null;

    if (
        raw.eventType === "item_listed" ||
        raw.eventType === "item_received_bid" ||
        raw.eventType === "item_received_offer"
    ) {
        const order = normalizeOffchainOrder(raw);
        if (
            !order ||
            order.sourceScopeKind !== ACTIVITY_SCOPE_KIND.Token ||
            !order.tokenId
        ) {
            return null;
        }
        const kind: ActivityKind =
            order.side === "sell"
                ? ACTIVITY_KIND.ListingCreated
                : ACTIVITY_KIND.BidCreated;

        return {
            chainId: raw.chainId,
            collectionId: raw.collectionId,
            scopeKind: ACTIVITY_SCOPE_KIND.Token,
            kind,
            contract: order.contract,
            tokenId: order.tokenId,
            occurredAt,
            sourceKind: "offchain",
            sourceName: raw.source,
            sourceEventKey: raw.dedupeKey,
            orderId: order.orderId,
            maker: order.maker,
            taker: order.taker ?? null,
            side: order.side,
            amount: parseStreamQuantity(raw.payload),
            price: order.price ?? null,
            currency: order.currency ?? null,
            payload: {
                eventType: raw.eventType,
                validFrom: order.validFrom ?? null,
                validUntil: order.validUntil ?? null,
            },
        };
    }

    if (
        raw.eventType === "item_cancelled" ||
        raw.eventType === "order_invalidate" ||
        raw.eventType === "order_invalidation"
    ) {
        if (
            !existingOrder ||
            existingOrder.sourceScopeKind !== ACTIVITY_SCOPE_KIND.Token ||
            !existingOrder.tokenId ||
            !existingOrder.side
        ) {
            return null;
        }

        return {
            chainId: raw.chainId,
            collectionId: raw.collectionId,
            scopeKind: ACTIVITY_SCOPE_KIND.Token,
            kind:
                existingOrder.side === "sell"
                    ? ACTIVITY_KIND.ListingCancelled
                    : ACTIVITY_KIND.BidCancelled,
            contract: existingOrder.contract,
            tokenId: existingOrder.tokenId,
            occurredAt,
            sourceKind: "offchain",
            sourceName: raw.source,
            sourceEventKey: raw.dedupeKey,
            orderId: raw.orderId ?? null,
            maker: existingOrder.maker,
            taker: existingOrder.taker,
            side: existingOrder.side,
            amount: parseStreamQuantity(raw.payload),
            price: existingOrder.price,
            currency: existingOrder.currency,
            payload: {
                eventType: raw.eventType,
            },
        };
    }

    return null;
}

function normalizeOpenSeaOrderPayload(
    raw: OffchainOrderRawPayload,
): RawOrderPayload | null {
    if (raw.channel === "stream") {
        return normalizeOpenSeaEvent(raw.payload);
    }

    return normalizeOpenSeaRestOrder(raw.eventType, raw.payload);
}

function parseStreamQuantity(rawPayload: unknown): string | null {
    const envelope = asObject(rawPayload, "payload");
    const payload = asObject(envelope.payload, "payload.payload");
    const quantity = payload.quantity;
    if (quantity === undefined || quantity === null) return null;
    if (typeof quantity === "string" && quantity.trim() !== "") return quantity;
    if (typeof quantity === "number" && Number.isFinite(quantity)) {
        return String(quantity);
    }
    return null;
}
