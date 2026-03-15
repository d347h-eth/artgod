import type { RawOrderPayload } from "./normalize.js";
import {
    asObject,
    assertAddress,
    assertString,
    normalizeCriteriaRoot,
    parseOptionalAddress,
    toBigInt,
} from "./normalizer-utils.js";
import {
    buildAttributeSchema,
    buildCollectionSchema,
} from "../token-sets/utils.js";
import { normalizeUniqueAttributeList } from "../../domain/attributes.js";
import { ORDER_SOURCE_SCOPE_KIND } from "../../domain/orders.js";
import {
    extractSeaportCriteriaOfferTerms,
    extractSeaportItemOfferTerms,
    extractSeaportSellTerms,
    normalizeSeaportOrderData,
} from "./seaport-order-data.js";

const NFT_ITEM_TYPES = new Set([2, 3, 4, 5]);
const PAYMENT_ITEM_TYPES = new Set([0, 1]);
const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";

export function normalizeOpenSeaRestOrder(
    recordType: string,
    raw: unknown,
): RawOrderPayload | null {
    const payload = asObject(raw, "payload");

    switch (recordType) {
        case "rest.listing":
            return normalizeRestListing(payload);
        case "rest.offer.item":
            return normalizeRestItemOffer(payload);
        case "rest.offer.collection":
            return normalizeRestCollectionOffer(payload);
        case "rest.offer.trait":
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
    const parameters = parseProtocolParameters(payload.protocol_data);
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
    const protocolTerms = extractSeaportItemOfferTerms(seaportData);
    const parameters = parseProtocolParameters(payload.protocol_data);
    const nftItem = requireNftItem(parameters.consideration, "consideration");
    const paymentItem = findPaymentItem(parameters.offer);

    return {
        orderId: parseOrderHash(payload),
        kind: "seaport",
        side: "buy",
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
                "protocol_data.parameters.consideration.token",
            ),
        tokenId:
            protocolTerms?.tokenId ??
            identifierToString(
                nftItem.identifierOrCriteria,
                "protocol_data.parameters.consideration.identifierOrCriteria",
            ),
        sourceScopeKind: ORDER_SOURCE_SCOPE_KIND.Token,
        sourceSchema: null,
        sourceCriteriaRoot: null,
        price: protocolTerms?.price ?? extractOfferPrice(payload, paymentItem),
        currency:
            protocolTerms?.currency ??
            (paymentItem
                ? assertAddress(
                      paymentItem.token,
                      "protocol_data.parameters.offer.token",
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

function normalizeRestCollectionOffer(
    payload: Record<string, unknown>,
): RawOrderPayload {
    const seaportData = normalizeSeaportOrderData(payload);
    const protocolTerms = extractSeaportCriteriaOfferTerms(seaportData);
    const parameters = parseProtocolParameters(payload.protocol_data);
    const contract = parseCriteriaContract(payload, parameters.consideration);
    const paymentItem = findPaymentItem(parameters.offer);

    return {
        orderId: parseOrderHash(payload),
        kind: "seaport",
        side: "buy",
        maker:
            protocolTerms?.maker ??
            assertAddress(
                parameters.offerer,
                "protocol_data.parameters.offerer",
            ),
        taker: parseOptionalAddress(payload.taker, "taker"),
        contract: protocolTerms?.contract ?? contract,
        tokenId: null,
        sourceScopeKind: ORDER_SOURCE_SCOPE_KIND.Collection,
        sourceSchema: buildCollectionSchema(
            protocolTerms?.contract ?? contract,
        ),
        sourceCriteriaRoot:
            protocolTerms?.criteriaRoot ??
            parseCriteriaRootFromItems(parameters.consideration),
        price: protocolTerms?.price ?? extractOfferPrice(payload, paymentItem),
        currency:
            protocolTerms?.currency ??
            (paymentItem
                ? assertAddress(
                      paymentItem.token,
                      "protocol_data.parameters.offer.token",
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

function normalizeRestTraitOffer(
    payload: Record<string, unknown>,
): RawOrderPayload {
    const seaportData = normalizeSeaportOrderData(payload);
    const protocolTerms = extractSeaportCriteriaOfferTerms(seaportData);
    const parameters = parseProtocolParameters(payload.protocol_data);
    const contract = parseCriteriaContract(payload, parameters.consideration);
    const paymentItem = findPaymentItem(parameters.offer);
    const attributes = parseTraitCriteria(payload);

    return {
        orderId: parseOrderHash(payload),
        kind: "seaport",
        side: "buy",
        maker:
            protocolTerms?.maker ??
            assertAddress(
                parameters.offerer,
                "protocol_data.parameters.offerer",
            ),
        taker: parseOptionalAddress(payload.taker, "taker"),
        contract: protocolTerms?.contract ?? contract,
        tokenId: null,
        sourceScopeKind: ORDER_SOURCE_SCOPE_KIND.Attribute,
        sourceSchema: buildAttributeSchema(
            protocolTerms?.contract ?? contract,
            attributes,
        ),
        sourceCriteriaRoot:
            protocolTerms?.criteriaRoot ??
            parseCriteriaRootFromItems(parameters.consideration),
        price: protocolTerms?.price ?? extractOfferPrice(payload, paymentItem),
        currency:
            protocolTerms?.currency ??
            (paymentItem
                ? assertAddress(
                      paymentItem.token,
                      "protocol_data.parameters.offer.token",
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
    return assertString(payload.order_hash, "order_hash").toLowerCase();
}

function parseCriteriaContract(
    payload: Record<string, unknown>,
    consideration: unknown,
): string {
    const criteria = asObject(payload.criteria, "criteria");
    const contract = toRecord(criteria.contract);
    const contractAddress = contract.address;
    if (contractAddress) {
        return assertAddress(contractAddress, "criteria.contract.address");
    }

    const nftItem = requireNftItem(consideration, "consideration");
    return assertAddress(
        nftItem.token,
        "protocol_data.parameters.consideration.token",
    );
}

function parseTraitCriteria(
    payload: Record<string, unknown>,
): Array<{ key: string; value: string }> {
    const criteria = asObject(payload.criteria, "criteria");
    const raw: Array<{ key: unknown; value: unknown }> = [];

    const single = toRecord(criteria.trait);
    if (single.type && single.value) {
        raw.push({
            key: single.type,
            value: single.value,
        });
    }

    const multi = criteria.traits;
    if (Array.isArray(multi)) {
        for (const entry of multi) {
            if (!entry || typeof entry !== "object") continue;
            const trait = entry as Record<string, unknown>;
            raw.push({
                key: trait.type,
                value: trait.value,
            });
        }
    }

    const normalized = normalizeUniqueAttributeList(raw);
    if (normalized.length === 0) {
        throw new Error("Missing criteria.trait/traits");
    }
    return normalized;
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

function parseCriteriaRootFromItems(items: unknown): string | null {
    if (!Array.isArray(items)) return null;
    for (const entry of items) {
        if (!entry || typeof entry !== "object") continue;
        const item = entry as Record<string, unknown>;
        const itemType = Number(item.itemType);
        if (!Number.isFinite(itemType) || !NFT_ITEM_TYPES.has(itemType)) {
            continue;
        }
        if (itemType !== 4 && itemType !== 5) {
            continue;
        }
        return normalizeCriteriaRoot(
            item.identifierOrCriteria,
            "protocol_data.parameters.consideration.identifierOrCriteria",
        );
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

function extractOfferPrice(
    payload: Record<string, unknown>,
    paymentItem: Record<string, unknown> | null,
): string {
    const price = asObject(payload.price, "price");
    if (price.value !== undefined && price.value !== null) {
        return String(price.value);
    }
    if (
        paymentItem?.startAmount !== undefined &&
        paymentItem.startAmount !== null
    ) {
        return String(paymentItem.startAmount);
    }
    throw new Error("Missing offer price");
}

function toRecord(value: unknown): Record<string, unknown> {
    return value && typeof value === "object"
        ? (value as Record<string, unknown>)
        : {};
}
