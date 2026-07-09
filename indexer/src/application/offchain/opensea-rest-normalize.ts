import type { RawOrderPayload } from "./normalize.js";
import {
    asObject,
    assertAddress,
    assertString,
    parseOptionalAddress,
    toBigInt,
} from "./normalizer-utils.js";
import { ORDER_SOURCE_SCOPE_KIND } from "../../domain/orders.js";
import { OPENSEA_REST_EVENT_TYPE } from "../../domain/offchain-jobs.js";
import {
    extractSeaportSellTerms,
    normalizeSeaportOrderData,
} from "./seaport-order-data.js";
import { parseRequiredOpenSeaBiddingOrderTerms } from "./opensea-bidding-order-terms.js";

const NFT_ITEM_TYPES = new Set([2, 3, 4, 5]);
const PAYMENT_ITEM_TYPES = new Set([0, 1]);
const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";

export function normalizeOpenSeaRestOrder(
    recordType: string,
    raw: unknown,
): RawOrderPayload | null {
    const payload = asObject(raw, "payload");

    switch (recordType) {
        case OPENSEA_REST_EVENT_TYPE.Listing:
            return normalizeRestListing(payload);
        case OPENSEA_REST_EVENT_TYPE.ItemOffer:
            return normalizeRestItemOffer(payload);
        case OPENSEA_REST_EVENT_TYPE.CollectionOffer:
            return normalizeRestCollectionOffer(payload);
        case OPENSEA_REST_EVENT_TYPE.TraitOffer:
            return normalizeRestTraitOffer(payload);
        default:
            return null;
    }
}

function normalizeRestListing(
    payload: Record<string, unknown>,
): RawOrderPayload {
    const seaportData = normalizeSeaportOrderData(payload);
    const protocolTerms = extractSeaportSellTerms(seaportData);
    const parameters = parseProtocolParameters(getProtocolData(payload));
    const nftItem = requireNftItem(parameters.offer, "offer");
    const paymentItem = findPaymentItem(parameters.consideration);

    return {
        orderId: parseOrderHash(payload),
        kind: "seaport",
        side: "sell",
        maker:
            protocolTerms?.maker ??
            assertAddress(
                parameters.offerer,
                "protocol_data.parameters.offerer",
            ),
        taker: parseOptionalAddress(payload.taker, "taker"),
        contract:
            protocolTerms?.contract ??
            assertAddress(
                nftItem.token,
                "protocol_data.parameters.offer.token",
            ),
        tokenId:
            protocolTerms?.tokenId ??
            identifierToString(
                nftItem.identifierOrCriteria,
                "protocol_data.parameters.offer.identifierOrCriteria",
            ),
        sourceScopeKind: ORDER_SOURCE_SCOPE_KIND.Token,
        sourceSchema: null,
        sourceCriteriaRoot: null,
        price:
            protocolTerms?.price ?? extractListingPrice(payload, paymentItem),
        currency:
            protocolTerms?.currency ??
            (paymentItem
                ? assertAddress(
                      paymentItem.token,
                      "protocol_data.parameters.consideration.token",
                  )
                : ZERO_ADDRESS),
        validFrom:
            protocolTerms?.validFrom ??
            unixSecondsToNumber(parameters.startTime, "startTime"),
        validUntil:
            protocolTerms?.validUntil ??
            unixSecondsToNumber(parameters.endTime, "endTime"),
        seaportData,
    };
}

function normalizeRestItemOffer(
    payload: Record<string, unknown>,
): RawOrderPayload {
    const seaportData = normalizeSeaportOrderData(payload);
    // Parse buy-offer order terms through the shared bidder-owned OpenSea parser.
    const terms = parseRequiredOpenSeaBiddingOrderTerms(payload, {
        context: {
            recordType: OPENSEA_REST_EVENT_TYPE.ItemOffer,
            orderHash: getOrderHash(payload),
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

function normalizeRestCollectionOffer(
    payload: Record<string, unknown>,
): RawOrderPayload {
    const seaportData = normalizeSeaportOrderData(payload);
    // Parse collection/criteria offer terms through the shared bidder-owned OpenSea parser.
    const terms = parseRequiredOpenSeaBiddingOrderTerms(payload, {
        context: {
            recordType: OPENSEA_REST_EVENT_TYPE.CollectionOffer,
            orderHash: getOrderHash(payload),
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

function normalizeRestTraitOffer(
    payload: Record<string, unknown>,
): RawOrderPayload {
    const seaportData = normalizeSeaportOrderData(payload);
    // Parse trait offer order terms through the shared bidder-owned OpenSea parser.
    const terms = parseRequiredOpenSeaBiddingOrderTerms(payload, {
        context: {
            recordType: OPENSEA_REST_EVENT_TYPE.TraitOffer,
            orderHash: getOrderHash(payload),
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

function parseProtocolParameters(value: unknown): Record<string, unknown> & {
    offer: unknown;
    consideration: unknown;
    offerer: unknown;
    startTime: unknown;
    endTime: unknown;
} {
    const protocolData = asObject(value, "protocol_data");
    return asObject(
        protocolData.parameters,
        "protocol_data.parameters",
    ) as Record<string, unknown> & {
        offer: unknown;
        consideration: unknown;
        offerer: unknown;
        startTime: unknown;
        endTime: unknown;
    };
}

function parseOrderHash(payload: Record<string, unknown>): string {
    return assertString(getOrderHash(payload), "order_hash").toLowerCase();
}

function getProtocolData(payload: Record<string, unknown>): unknown {
    return payload.protocol_data ?? payload.protocolData;
}

function getOrderHash(payload: Record<string, unknown>): unknown {
    return payload.order_hash ?? payload.orderHash;
}

function requireNftItem(items: unknown, name: string): Record<string, unknown> {
    const item = findNftItem(items);
    if (!item) {
        throw new Error(`Missing NFT item in ${name}`);
    }
    return item;
}

function findNftItem(items: unknown): Record<string, unknown> | null {
    if (!Array.isArray(items)) return null;
    for (const entry of items) {
        if (!entry || typeof entry !== "object") continue;
        const item = entry as Record<string, unknown>;
        const itemType = Number(item.itemType);
        if (!Number.isFinite(itemType) || !NFT_ITEM_TYPES.has(itemType)) {
            continue;
        }
        return item;
    }
    return null;
}

function findPaymentItem(items: unknown): Record<string, unknown> | null {
    if (!Array.isArray(items)) return null;
    for (const entry of items) {
        if (!entry || typeof entry !== "object") continue;
        const item = entry as Record<string, unknown>;
        const itemType = Number(item.itemType);
        if (!Number.isFinite(itemType) || !PAYMENT_ITEM_TYPES.has(itemType)) {
            continue;
        }
        return item;
    }
    return null;
}

function identifierToString(value: unknown, name: string): string {
    const identifier = toBigInt(value, name);
    return identifier.toString();
}

function unixSecondsToNumber(value: unknown, name: string): number | null {
    return Number(toBigInt(value, name));
}

function extractListingPrice(
    payload: Record<string, unknown>,
    paymentItem: Record<string, unknown> | null,
): string {
    const price = asObject(payload.price, "price");
    const current = asObject(price.current, "price.current");
    if (current.value !== undefined && current.value !== null) {
        return String(current.value);
    }
    if (
        paymentItem?.startAmount !== undefined &&
        paymentItem.startAmount !== null
    ) {
        return String(paymentItem.startAmount);
    }
    throw new Error("Missing listing price");
}
