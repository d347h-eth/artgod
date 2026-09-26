import type { RawOrderPayload } from "./normalize.js";
import {
    ORDER_UPDATE_REASON,
    type OrderUpdateReason,
    type OrderUpdateByMakerReason,
} from "../../domain/order-jobs.js";
import {
    ORDER_LOCAL_TOKEN_SET_STATUS,
    ORDER_SOURCE_SCOPE_KIND,
    ORDER_SOURCE_STATUS,
    type OrderSourceStatus,
} from "../../domain/orders.js";
import {
    assertAddress,
    assertPaymentToken,
    assertPrice,
    parseOptionalAddress,
    parseTimestamp,
} from "@artgod/shared/offchain/normalizer-utils";
import { logger } from "@artgod/shared/utils";
import {
    extractSeaportSellTerms,
    normalizeSeaportOrderData,
} from "./seaport-order-data.js";
import { parseRequiredOpenSeaBiddingOrderTerms } from "./opensea-bidding-order-terms.js";
import {
    getOpenSeaEventIdentifiers,
    getOpenSeaOrderHash,
    parseOpenSeaOrderHash,
    OPENSEA_STREAM_EVENT_TYPE,
    parseNftId,
    parseOpenSeaEnvelope,
} from "@artgod/shared/opensea/payload";
import { TOKEN_SCOPED_MAKER_TRIGGER_REASON } from "../../domain/maker-triggers.js";

export type OpenSeaOrderUpdate = {
    orderId: string;
    reason: OrderUpdateReason;
    sourceStatus: OrderSourceStatus;
    validUntil?: number | null;
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

    if (eventType === OPENSEA_STREAM_EVENT_TYPE.ItemListed) {
        return normalizeItemListed(payload);
    }
    if (eventType === OPENSEA_STREAM_EVENT_TYPE.ItemReceivedBid) {
        return normalizeItemReceivedBid(payload, eventType);
    }
    if (eventType === OPENSEA_STREAM_EVENT_TYPE.ItemReceivedOffer) {
        return normalizeItemReceivedBid(payload, eventType);
    }
    if (eventType === OPENSEA_STREAM_EVENT_TYPE.CollectionOffer) {
        return normalizeCollectionOffer(payload);
    }
    if (eventType === OPENSEA_STREAM_EVENT_TYPE.TraitOffer) {
        return normalizeTraitOffer(payload);
    }

    // This event is not for "order upsert".
    return null;
}

export function normalizeOpenSeaOrderUpdate(
    raw: unknown,
): OpenSeaOrderUpdate | null {
    const { eventType, payload } = parseOpenSeaEnvelope(raw);

    if (eventType === OPENSEA_STREAM_EVENT_TYPE.ItemCancelled) {
        return {
            orderId: parseOpenSeaOrderHash(payload),
            reason: ORDER_UPDATE_REASON.Cancel,
            sourceStatus: ORDER_SOURCE_STATUS.Cancelled,
            validUntil: parseOrderUpdateExpiry(payload.expiration_date),
        };
    }
    if (
        eventType === OPENSEA_STREAM_EVENT_TYPE.OrderInvalidate ||
        eventType === OPENSEA_STREAM_EVENT_TYPE.OrderInvalidation
    ) {
        return {
            orderId: parseOpenSeaOrderHash(payload),
            reason: ORDER_UPDATE_REASON.Cancel,
            sourceStatus: ORDER_SOURCE_STATUS.Invalidated,
        };
    }
    if (
        eventType === OPENSEA_STREAM_EVENT_TYPE.OrderRevalidate ||
        eventType === OPENSEA_STREAM_EVENT_TYPE.OrderRevalidation
    ) {
        return {
            orderId: parseOpenSeaOrderHash(payload),
            reason: ORDER_UPDATE_REASON.Validation,
            sourceStatus: ORDER_SOURCE_STATUS.Active,
        };
    }
    if (eventType === OPENSEA_STREAM_EVENT_TYPE.ItemSold) {
        const { orderId } = getOpenSeaEventIdentifiers(raw);
        // An incomplete sale can still trigger token revalidation, but cannot
        // identify an order to mark filled. Do not derive an id from other terms.
        if (!orderId) return null;
        return {
            orderId,
            reason: ORDER_UPDATE_REASON.Fill,
            sourceStatus: ORDER_SOURCE_STATUS.Filled,
            validUntil: parseOrderUpdateExpiry(payload.expiration_date),
        };
    }

    // This event is not for the specific order update.
    return null;
}

function parseOrderUpdateExpiry(value: unknown): number | null {
    try {
        const expiry = parseTimestamp(value, "expiration_date");
        return expiry !== null && expiry > 0 ? expiry : null;
    } catch {
        // Optional expiry must not turn a definitive cancellation into a lost
        // update. Missing/malformed dates retain the unknown-expiry fallback.
        return null;
    }
}

export function normalizeOpenSeaMetadataRefresh(
    raw: unknown,
): OpenSeaMetadataRefresh | null {
    const { eventType, payload } = parseOpenSeaEnvelope(raw);
    if (eventType !== OPENSEA_STREAM_EVENT_TYPE.ItemMetadataUpdated)
        return null;

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

    if (eventType === OPENSEA_STREAM_EVENT_TYPE.ItemTransferred) {
        const { contract, tokenId } = parseRequiredNftId(payload.item);
        return {
            maker: assertAddress(payload.from_account, "from_account"),
            contract,
            tokenId,
            reason: "item_transferred",
        };
    }

    if (eventType === OPENSEA_STREAM_EVENT_TYPE.ItemSold) {
        const { maker, contract, tokenId } = getOpenSeaEventIdentifiers(raw);
        if (!maker || !contract || tokenId === null)
            throw new Error(
                "Invalid OpenSea sale: expected seller and NFT identity",
            );
        // The stream maker is the seller even when accepting a bid; its Seaport
        // offerer may be the buyer and cannot substitute for the seller.
        return {
            maker,
            contract,
            tokenId,
            reason: TOKEN_SCOPED_MAKER_TRIGGER_REASON.ItemSold,
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
    const orderHash = parseOpenSeaOrderHash(payload);
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
        orderId: orderHash,
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
            orderHash: getOpenSeaOrderHash(payload),
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
            eventType: OPENSEA_STREAM_EVENT_TYPE.CollectionOffer,
            orderHash: getOpenSeaOrderHash(payload),
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
            eventType: OPENSEA_STREAM_EVENT_TYPE.TraitOffer,
            orderHash: getOpenSeaOrderHash(payload),
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
