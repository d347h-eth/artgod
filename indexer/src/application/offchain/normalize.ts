import type { OffchainOrderRawPayload } from "../../domain/offchain-jobs.js";
import type { OrderUpdateByMakerReason } from "../../domain/order-jobs.js";
import type { OrderSourceStatus } from "../../domain/orders.js";
import type { TokenSetSchema } from "../../domain/token-sets.js";
import {
    normalizeOpenSeaEvent,
    normalizeOpenSeaMakerUpdate,
    normalizeOpenSeaMetadataRefresh,
    normalizeOpenSeaOrderUpdate,
} from "./opensea-normalize.js";
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
    tokenSetSchema?: TokenSetSchema;
    criteriaRoot?: string | null;
    price?: string | null;
    currency?: string | null;
    validFrom?: number | null;
    validUntil?: number | null;
};

export type NormalizedOffchainOrder = RawOrderPayload & {
    chainId: number;
    source: string;
    rawData: unknown;
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
    reason: OrderUpdateByMakerReason;
};

export type NormalizedOffchainMetadataRefresh = {
    chainId: number;
    source: string;
    contract: string;
    tokenId: string;
    metadataUrl: string | null;
    reason: "metadata_updated";
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
            ? normalizeOpenSeaEvent(raw.payload)
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
        tokenSetSchema: order.tokenSetSchema,
        criteriaRoot: order.criteriaRoot ?? null,
        price: order.price ?? null,
        currency: parseOptionalAddress(order.currency, "currency"),
        validFrom: order.validFrom ?? null,
        validUntil: order.validUntil ?? null,
        source: raw.source,
        rawData: raw.payload,
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
        validFrom: parseOptionalNumber(value.validFrom, "validFrom"),
        validUntil: parseOptionalNumber(value.validUntil, "validUntil"),
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

    if (raw.source !== "opensea") return null;
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

    if (raw.source !== "opensea") return null;
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

    if (raw.source !== "opensea") return null;
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
