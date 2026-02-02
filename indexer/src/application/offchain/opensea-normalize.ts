import type { RawOrderPayload } from "./normalize.js";
import type { TokenSetSchema } from "../../domain/token-sets.js";
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
import { normalizeUniqueAttributeList } from "../../domain/attributes.js";

const SEAPORT_ITEM_TYPE_ERC721_WITH_CRITERIA = 4;
const SEAPORT_ITEM_TYPE_ERC1155_WITH_CRITERIA = 5;

export function normalizeOpenSeaEvent(raw: unknown): RawOrderPayload | null {
    const envelope = asObject(raw, "OpenSea envelope");
    const eventType =
        typeof envelope.event_type === "string" ? envelope.event_type : null;
    const payload =
        envelope.payload && typeof envelope.payload === "object"
            ? (envelope.payload as Record<string, unknown>)
            : null;

    if (!eventType || !payload) {
        throw new Error("Invalid OpenSea payload");
    }

    if (eventType === "item_listed") {
        return normalizeItemListed(payload);
    }
    if (eventType === "item_received_bid") {
        return normalizeItemReceivedBid(payload);
    }
    if (eventType === "collection_offer") {
        return normalizeCollectionOffer(payload);
    }
    if (eventType === "trait_offer") {
        return normalizeTraitOffer(payload);
    }

    // Other OpenSea events are currently ignored by the offchain pipeline.
    return null;
}

function normalizeItemListed(
    payload: Record<string, unknown>,
): RawOrderPayload {
    const orderHash = assertString(payload.order_hash, "order_hash");
    const maker = assertAddress(payload.maker, "maker");
    const { contract, tokenId } = parseNftId(payload.item);
    const price = assertPrice(payload.base_price, "base_price");
    const currency = assertPaymentToken(payload.payment_token, "payment_token");
    const validFrom = parseTimestamp(payload.listing_date, "listing_date");
    const validUntil = parseTimestamp(
        payload.expiration_date,
        "expiration_date",
    );

    return {
        orderId: orderHash.toLowerCase(),
        kind: "seaport",
        side: "sell",
        maker,
        taker: parseOptionalAddress(payload.taker, "taker"),
        contract,
        tokenId,
        price,
        currency,
        validFrom,
        validUntil,
    };
}

function normalizeItemReceivedBid(
    payload: Record<string, unknown>,
): RawOrderPayload {
    const orderHash = assertString(payload.order_hash, "order_hash");
    const maker = assertAddress(payload.maker, "maker");
    const { contract, tokenId } = parseNftId(payload.item);
    const price = assertPrice(payload.base_price, "base_price");
    const currency = assertPaymentToken(payload.payment_token, "payment_token");
    const validFrom = parseTimestamp(payload.created_date, "created_date");
    const validUntil = parseTimestamp(
        payload.expiration_date,
        "expiration_date",
    );

    return {
        orderId: orderHash.toLowerCase(),
        kind: "seaport",
        side: "buy",
        maker,
        taker: parseOptionalAddress(payload.taker, "taker"),
        contract,
        tokenId,
        price,
        currency,
        validFrom,
        validUntil,
    };
}

function normalizeCollectionOffer(
    payload: Record<string, unknown>,
): RawOrderPayload {
    const orderHash = assertString(payload.order_hash, "order_hash");
    const maker = assertAddress(payload.maker, "maker");
    const contract = parseCriteriaContract(payload);
    const price = assertPrice(payload.base_price, "base_price");
    const currency = assertPaymentToken(payload.payment_token, "payment_token");
    const validFrom = parseTimestamp(payload.created_date, "created_date");
    const validUntil = parseTimestamp(
        payload.expiration_date,
        "expiration_date",
    );

    return {
        orderId: orderHash.toLowerCase(),
        kind: "seaport",
        side: "buy",
        maker,
        taker: parseOptionalAddress(payload.taker, "taker"),
        contract,
        tokenId: null,
        tokenSetSchema: {
            kind: "collection",
            data: { collection: contract },
        },
        criteriaRoot: parseCriteriaRoot(payload),
        price,
        currency,
        validFrom,
        validUntil,
    };
}

function normalizeTraitOffer(
    payload: Record<string, unknown>,
): RawOrderPayload {
    const orderHash = assertString(payload.order_hash, "order_hash");
    const maker = assertAddress(payload.maker, "maker");
    const contract = parseCriteriaContract(payload);
    const price = assertPrice(payload.base_price, "base_price");
    const currency = assertPaymentToken(payload.payment_token, "payment_token");
    const validFrom = parseTimestamp(payload.created_date, "created_date");
    const validUntil = parseTimestamp(
        payload.expiration_date,
        "expiration_date",
    );

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
        tokenSetSchema,
        criteriaRoot: parseCriteriaRoot(payload),
        price,
        currency,
        validFrom,
        validUntil,
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
        const identifier = entry.identifierOrCriteria;
        if (typeof identifier === "string") return identifier;
        if (typeof identifier === "bigint") return identifier.toString();
        if (typeof identifier === "number" && Number.isFinite(identifier)) {
            return String(identifier);
        }
    }

    return null;
}
