import type { RawOrderPayload } from "./normalize.js";
import type { OrderUpdateByMakerReason } from "../../domain/order-jobs.js";
import {
    ORDER_LOCAL_TOKEN_SET_STATUS,
    ORDER_SOURCE_SCOPE_KIND,
    type OrderSourceStatus,
} from "../../domain/orders.js";
import {
    asObject,
    assertAddress,
    assertPaymentToken,
    assertPrice,
    assertString,
    parseNftId,
    parseOptionalAddress,
    parseTimestamp,
} from "./normalizer-utils.js";
import { logger } from "@artgod/shared/utils";
import {
    extractSeaportSellTerms,
    normalizeSeaportOrderData,
} from "./seaport-order-data.js";
import { parseRequiredOpenSeaBiddingOrderTerms } from "./opensea-bidding-order-terms.js";

export type OpenSeaOrderUpdate = {
    orderId: string;
    reason: "cancel" | "order" | "fill";
    sourceStatus: OrderSourceStatus;
};

export type OpenSeaMetadataRefresh = {
    contract: string;
    tokenId: string;
    metadataUrl: string | null;
    reason: "metadata_updated";
};

export type OpenSeaMakerUpdate = {
    maker: string;
    contract: string;
    tokenId: string;
    reason: Extract<OrderUpdateByMakerReason, "item_sold" | "item_transferred">;
};

export function normalizeOpenSeaEvent(raw: unknown): RawOrderPayload | null {
    const { eventType, payload } = parseOpenSeaEnvelope(raw);

    if (eventType === "item_listed") {
        return normalizeItemListed(payload);
    }
    if (eventType === "item_received_bid") {
        return normalizeItemReceivedBid(payload, eventType);
    }
    if (eventType === "item_received_offer") {
        return normalizeItemReceivedBid(payload, eventType);
    }
    if (eventType === "collection_offer") {
        return normalizeCollectionOffer(payload);
    }
    if (eventType === "trait_offer") {
        return normalizeTraitOffer(payload);
    }

    // This event is not for "order upsert".
    return null;
}

export function normalizeOpenSeaOrderUpdate(
    raw: unknown,
): OpenSeaOrderUpdate | null {
    const { eventType, payload } = parseOpenSeaEnvelope(raw);

    if (eventType === "item_cancelled") {
        return {
            orderId: parseOrderHash(payload),
            reason: "cancel",
            sourceStatus: "cancelled",
        };
    }
    if (
        eventType === "order_invalidate" ||
        eventType === "order_invalidation"
    ) {
        return {
            orderId: parseOrderHash(payload),
            reason: "cancel",
            sourceStatus: "invalidated",
        };
    }
    if (
        eventType === "order_revalidate" ||
        eventType === "order_revalidation"
    ) {
        return {
            orderId: parseOrderHash(payload),
            reason: "order",
            sourceStatus: "active",
        };
    }
    if (eventType === "item_sold") {
        return {
            orderId: parseOrderHash(payload),
            reason: "fill",
            sourceStatus: "filled",
        };
    }

    // This event is not for the specific order update.
    return null;
}

export function normalizeOpenSeaMetadataRefresh(
    raw: unknown,
): OpenSeaMetadataRefresh | null {
    const { eventType, payload } = parseOpenSeaEnvelope(raw);
    if (eventType !== "item_metadata_updated") return null;

    const { contract, tokenId } = parseRequiredNftId(payload.item);
    const metadataUrl = parseMetadataUrl(payload);

    return {
        contract,
        tokenId,
        metadataUrl,
        reason: "metadata_updated",
    };
}

export function normalizeOpenSeaMakerUpdate(
    raw: unknown,
): OpenSeaMakerUpdate | null {
    const { eventType, payload } = parseOpenSeaEnvelope(raw);

    if (eventType === "item_transferred") {
        const { contract, tokenId } = parseRequiredNftId(payload.item);
        return {
            maker: assertAddress(payload.from_account, "from_account"),
            contract,
            tokenId,
            reason: "item_transferred",
        };
    }

    if (eventType === "item_sold") {
        const { contract, tokenId } = parseRequiredNftId(payload.item);
        return {
            maker: assertAddress(payload.maker, "maker"),
            contract,
            tokenId,
            reason: "item_sold",
        };
    }

    // This event is not for maker-scoped orders update.
    return null;
}

function normalizeItemListed(
    payload: Record<string, unknown>,
): RawOrderPayload {
    const seaportData = normalizeSeaportOrderData(payload);
    const protocolTerms = extractSeaportSellTerms(seaportData);
    const orderHash = assertString(payload.order_hash, "order_hash");
    const maker = protocolTerms?.maker ?? assertAddress(payload.maker, "maker");
    const { contract, tokenId } = protocolTerms
        ? {
              contract: protocolTerms.contract,
              tokenId: protocolTerms.tokenId,
          }
        : parseNftId(payload.item);
    const price =
        protocolTerms?.price ?? assertPrice(payload.base_price, "base_price");
    const currency =
        protocolTerms?.currency ??
        assertPaymentToken(payload.payment_token, "payment_token");
    const validFrom =
        protocolTerms?.validFrom ??
        parseTimestamp(payload.listing_date, "listing_date");
    const validUntil =
        protocolTerms?.validUntil ??
        parseTimestamp(payload.expiration_date, "expiration_date");

    return {
        orderId: orderHash.toLowerCase(),
        kind: "seaport",
        side: "sell",
        maker,
        taker: parseOptionalAddress(payload.taker, "taker"),
        contract,
        tokenId,
        sourceScopeKind: ORDER_SOURCE_SCOPE_KIND.Token,
        sourceSchema: null,
        sourceCriteriaRoot: null,
        localTokenSetStatus: ORDER_LOCAL_TOKEN_SET_STATUS.None,
        price,
        currency,
        validFrom,
        validUntil,
        seaportData,
    };
}

function normalizeItemReceivedBid(
    payload: Record<string, unknown>,
    eventType: "item_received_bid" | "item_received_offer",
): RawOrderPayload {
    const seaportData = normalizeSeaportOrderData(payload);
    // Parse buy-offer order terms through the shared bidder-owned OpenSea parser.
    const terms = parseRequiredOpenSeaBiddingOrderTerms(payload, {
        context: {
            eventType,
            orderHash: payload.order_hash,
        },
    });

    return {
        orderId: terms.orderId,
        kind: "seaport",
        side: "buy",
        maker: terms.maker,
        taker: parseOptionalAddress(payload.taker, "taker"),
        contract: terms.contract,
        tokenId: terms.tokenId,
        sourceScopeKind: terms.sourceScopeKind,
        sourceSchema: terms.sourceSchema,
        sourceCriteriaRoot: terms.sourceCriteriaRoot,
        sourceEncodedTokenIds: terms.sourceEncodedTokenIds,
        localTokenSetStatus: terms.localTokenSetStatus,
        quantity: terms.quantity,
        price: terms.price,
        currency: terms.currency,
        validFrom: terms.validFrom,
        validUntil: terms.validUntil,
        seaportData,
    };
}

function normalizeCollectionOffer(
    payload: Record<string, unknown>,
): RawOrderPayload {
    const seaportData = normalizeSeaportOrderData(payload);
    // Parse collection/criteria offer terms through the shared bidder-owned OpenSea parser.
    const terms = parseRequiredOpenSeaBiddingOrderTerms(payload, {
        context: {
            eventType: "collection_offer",
            orderHash: payload.order_hash,
        },
    });

    return {
        orderId: terms.orderId,
        kind: "seaport",
        side: "buy",
        maker: terms.maker,
        taker: parseOptionalAddress(payload.taker, "taker"),
        contract: terms.contract,
        tokenId: terms.tokenId,
        sourceScopeKind: terms.sourceScopeKind,
        sourceSchema: terms.sourceSchema,
        sourceCriteriaRoot: terms.sourceCriteriaRoot,
        sourceEncodedTokenIds: terms.sourceEncodedTokenIds,
        localTokenSetStatus: terms.localTokenSetStatus,
        quantity: terms.quantity,
        price: terms.price,
        currency: terms.currency,
        validFrom: terms.validFrom,
        validUntil: terms.validUntil,
        seaportData,
    };
}

function normalizeTraitOffer(
    payload: Record<string, unknown>,
): RawOrderPayload {
    const seaportData = normalizeSeaportOrderData(payload);
    // Parse trait offer terms through the shared bidder-owned OpenSea parser.
    const terms = parseRequiredOpenSeaBiddingOrderTerms(payload, {
        context: {
            eventType: "trait_offer",
            orderHash: payload.order_hash,
        },
    });

    return {
        orderId: terms.orderId,
        kind: "seaport",
        side: "buy",
        maker: terms.maker,
        taker: parseOptionalAddress(payload.taker, "taker"),
        contract: terms.contract,
        tokenId: terms.tokenId,
        sourceScopeKind: terms.sourceScopeKind,
        sourceSchema: terms.sourceSchema,
        sourceCriteriaRoot: terms.sourceCriteriaRoot,
        sourceEncodedTokenIds: terms.sourceEncodedTokenIds,
        localTokenSetStatus: terms.localTokenSetStatus,
        quantity: terms.quantity,
        price: terms.price,
        currency: terms.currency,
        validFrom: terms.validFrom,
        validUntil: terms.validUntil,
        seaportData,
    };
}

function parseOpenSeaEnvelope(raw: unknown): {
    eventType: string;
    payload: Record<string, unknown>;
} {
    const envelope = asObject(raw, "OpenSea envelope");
    const eventType =
        typeof envelope.event_type === "string" ? envelope.event_type : null;
    if (!eventType) {
        throw new Error("Invalid OpenSea payload");
    }

    const payloadValue = envelope.payload;
    const payload =
        payloadValue && typeof payloadValue === "object"
            ? (payloadValue as Record<string, unknown>)
            : envelope;

    return { eventType, payload };
}

function parseOrderHash(payload: Record<string, unknown>): string {
    return assertString(payload.order_hash, "order_hash").toLowerCase();
}

function parseRequiredNftId(value: unknown): {
    contract: string;
    tokenId: string;
} {
    try {
        return parseNftId(value);
    } catch (error) {
        logger.error("OpenSea metadata refresh missing nft_id", {
            component: "OpenSeaNormalizer",
            action: "metadataRefresh",
            error: String(error),
        });
        throw error;
    }
}

function parseMetadataUrl(payload: Record<string, unknown>): string | null {
    if (typeof payload.metadata_url === "string") {
        return payload.metadata_url;
    }
    const item = payload.item;
    if (!item || typeof item !== "object") return null;
    const itemRecord = item as Record<string, unknown>;
    if (typeof itemRecord.metadata_url === "string") {
        return itemRecord.metadata_url;
    }
    const metadata = itemRecord.metadata;
    if (!metadata || typeof metadata !== "object") return null;
    const metadataRecord = metadata as Record<string, unknown>;
    return typeof metadataRecord.metadata_url === "string"
        ? metadataRecord.metadata_url
        : null;
}
