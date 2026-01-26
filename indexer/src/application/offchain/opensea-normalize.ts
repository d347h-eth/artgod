import type { RawOrderPayload } from "./normalize.js";
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
