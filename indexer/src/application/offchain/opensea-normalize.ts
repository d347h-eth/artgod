import type { RawOrderPayload } from "./normalize.js";
import type { TokenSetSchema } from "../../domain/token-sets.js";
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
    normalizeCriteriaRoot,
    parseNftId,
    parseOptionalAddress,
    parseTimestamp,
} from "./normalizer-utils.js";
import { logger } from "@artgod/shared/utils";
import { normalizeUniqueAttributeList } from "../../domain/attributes.js";
import {
    extractSeaportCriteriaOfferTerms,
    extractSeaportItemOfferTerms,
    extractSeaportSellTerms,
    normalizeSeaportOrderData,
} from "./seaport-order-data.js";

const SEAPORT_ITEM_TYPE_ERC721_WITH_CRITERIA = 4;
const SEAPORT_ITEM_TYPE_ERC1155_WITH_CRITERIA = 5;

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
        return normalizeItemReceivedBid(payload);
    }
    if (eventType === "item_received_offer") {
        return normalizeItemReceivedBid(payload);
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
    const price = protocolTerms?.price ?? assertPrice(payload.base_price, "base_price");
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
): RawOrderPayload {
    const seaportData = normalizeSeaportOrderData(payload);
    const protocolTerms = extractSeaportItemOfferTerms(seaportData);
    const orderHash = assertString(payload.order_hash, "order_hash");
    const maker = protocolTerms?.maker ?? assertAddress(payload.maker, "maker");
    const { contract, tokenId } = protocolTerms
        ? {
              contract: protocolTerms.contract,
              tokenId: protocolTerms.tokenId,
          }
        : parseNftId(payload.item);
    const price = protocolTerms?.price ?? assertPrice(payload.base_price, "base_price");
    const currency =
        protocolTerms?.currency ??
        assertPaymentToken(payload.payment_token, "payment_token");
    const validFrom =
        protocolTerms?.validFrom ??
        parseTimestamp(payload.created_date, "created_date");
    const validUntil =
        protocolTerms?.validUntil ??
        parseTimestamp(payload.expiration_date, "expiration_date");

    return {
        orderId: orderHash.toLowerCase(),
        kind: "seaport",
        side: "buy",
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

function normalizeCollectionOffer(
    payload: Record<string, unknown>,
): RawOrderPayload {
    const seaportData = normalizeSeaportOrderData(payload);
    const protocolTerms = extractSeaportCriteriaOfferTerms(seaportData);
    const orderHash = assertString(payload.order_hash, "order_hash");
    const maker = protocolTerms?.maker ?? assertAddress(payload.maker, "maker");
    const contract = protocolTerms?.contract ?? parseCriteriaContract(payload);
    const price = protocolTerms?.price ?? assertPrice(payload.base_price, "base_price");
    const currency =
        protocolTerms?.currency ??
        assertPaymentToken(payload.payment_token, "payment_token");
    const validFrom =
        protocolTerms?.validFrom ??
        parseTimestamp(payload.created_date, "created_date");
    const validUntil =
        protocolTerms?.validUntil ??
        parseTimestamp(payload.expiration_date, "expiration_date");

    return {
        orderId: orderHash.toLowerCase(),
        kind: "seaport",
        side: "buy",
        maker,
        taker: parseOptionalAddress(payload.taker, "taker"),
        contract,
        tokenId: null,
        sourceScopeKind: ORDER_SOURCE_SCOPE_KIND.Collection,
        sourceSchema: {
            kind: "collection",
            data: { collection: contract },
        },
        sourceCriteriaRoot: protocolTerms?.criteriaRoot ?? parseCriteriaRoot(payload),
        localTokenSetStatus: ORDER_LOCAL_TOKEN_SET_STATUS.Unresolved,
        price,
        currency,
        validFrom,
        validUntil,
        seaportData,
    };
}

function normalizeTraitOffer(
    payload: Record<string, unknown>,
): RawOrderPayload {
    const seaportData = normalizeSeaportOrderData(payload);
    const protocolTerms = extractSeaportCriteriaOfferTerms(seaportData);
    const orderHash = assertString(payload.order_hash, "order_hash");
    const maker = protocolTerms?.maker ?? assertAddress(payload.maker, "maker");
    const contract = protocolTerms?.contract ?? parseCriteriaContract(payload);
    const price = protocolTerms?.price ?? assertPrice(payload.base_price, "base_price");
    const currency =
        protocolTerms?.currency ??
        assertPaymentToken(payload.payment_token, "payment_token");
    const validFrom =
        protocolTerms?.validFrom ??
        parseTimestamp(payload.created_date, "created_date");
    const validUntil =
        protocolTerms?.validUntil ??
        parseTimestamp(payload.expiration_date, "expiration_date");

    const attributes = parseTraitCriteria(payload);
    const tokenSetSchema: TokenSetSchema = {
        kind: "attribute",
        data: {
            collection: contract,
            attributes,
        },
    };

    return {
        orderId: orderHash.toLowerCase(),
        kind: "seaport",
        side: "buy",
        maker,
        taker: parseOptionalAddress(payload.taker, "taker"),
        contract,
        tokenId: null,
        sourceScopeKind: ORDER_SOURCE_SCOPE_KIND.Attribute,
        sourceSchema: tokenSetSchema,
        sourceCriteriaRoot: protocolTerms?.criteriaRoot ?? parseCriteriaRoot(payload),
        localTokenSetStatus: ORDER_LOCAL_TOKEN_SET_STATUS.Unresolved,
        price,
        currency,
        validFrom,
        validUntil,
        seaportData,
    };
}

function parseCriteriaContract(payload: Record<string, unknown>): string {
    const assetCriteria = asObject(
        payload.asset_contract_criteria,
        "asset_contract_criteria",
    );
    return assertAddress(
        assetCriteria.address,
        "asset_contract_criteria.address",
    );
}

function parseTraitCriteria(
    payload: Record<string, unknown>,
): Array<{ key: string; value: string }> {
    const criteria = payload.trait_criteria;
    const criteriaList = payload.trait_criteria_list;
    const raw: Array<{ key: unknown; value: unknown }> = [];

    if (criteria && typeof criteria === "object") {
        const entry = criteria as Record<string, unknown>;
        raw.push({
            key: entry.trait_type,
            value: entry.trait_name,
        });
    }

    if (Array.isArray(criteriaList)) {
        for (const item of criteriaList) {
            if (!item || typeof item !== "object") continue;
            const entry = item as Record<string, unknown>;
            raw.push({
                key: entry.trait_type,
                value: entry.trait_name,
            });
        }
    }

    const normalized = normalizeUniqueAttributeList(raw);
    if (normalized.length === 0) {
        throw new Error("Missing trait criteria");
    }
    return normalized;
}

function parseCriteriaRoot(payload: Record<string, unknown>): string | null {
    const protocol = payload.protocol_data;
    if (!protocol || typeof protocol !== "object") return null;
    const parameters = (protocol as Record<string, unknown>).parameters;
    if (!parameters || typeof parameters !== "object") return null;
    const consideration = (parameters as Record<string, unknown>).consideration;
    if (!Array.isArray(consideration)) return null;

    for (const item of consideration) {
        if (!item || typeof item !== "object") continue;
        const entry = item as Record<string, unknown>;
        const itemType = Number(entry.itemType);
        if (!Number.isFinite(itemType)) continue;
        if (
            itemType !== SEAPORT_ITEM_TYPE_ERC721_WITH_CRITERIA &&
            itemType !== SEAPORT_ITEM_TYPE_ERC1155_WITH_CRITERIA
        ) {
            continue;
        }
        return normalizeCriteriaRoot(
            entry.identifierOrCriteria,
            "protocol_data.parameters.consideration.identifierOrCriteria",
        );
    }

    return null;
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
