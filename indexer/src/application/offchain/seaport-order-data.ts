import { seaportIsNftItem } from "@artgod/shared/market-data/seaport";
import { declaredOrderQuote } from "../../domain/order-quantity.js";
import { ORDER_SIDE } from "../../domain/orders.js";
import type {
    SeaportConsiderationItem,
    SeaportOrderData,
    SeaportOrderItem,
} from "../../domain/orders.js";
import {
    asObject,
    assertAddress,
    assertString,
    parseOptionalString,
    toBigInt,
} from "@artgod/shared/offchain/normalizer-utils";
import { getOpenSeaProtocolData } from "@artgod/shared/opensea/payload";

export function normalizeSeaportOrderData(
    payload: Record<string, unknown>,
): SeaportOrderData | null {
    const protocolAddress = payload.protocol_address ?? payload.protocolAddress;
    const protocolData = getOpenSeaProtocolData(payload);
    if (!protocolAddress || !protocolData) {
        return null;
    }

    const normalizedProtocolAddress = assertAddress(
        protocolAddress,
        "protocol_address",
    );
    const protocol = asObject(protocolData, "protocol_data");
    const parameters = asObject(
        protocol.parameters,
        "protocol_data.parameters",
    );

    return {
        protocolAddress: normalizedProtocolAddress,
        signature: parseOptionalString(
            protocol.signature,
            "protocol_data.signature",
        ),
        offerer: assertAddress(parameters.offerer, "offerer"),
        zone: assertAddress(parameters.zone, "zone"),
        offer: parseOfferItems(parameters.offer),
        consideration: parseConsiderationItems(parameters.consideration),
        orderType: normalizeUint(parameters.orderType, "orderType"),
        startTime: normalizeUint(parameters.startTime, "startTime"),
        endTime: normalizeUint(parameters.endTime, "endTime"),
        zoneHash: assertString(parameters.zoneHash, "zoneHash"),
        salt: normalizeUint(parameters.salt, "salt"),
        conduitKey: assertString(parameters.conduitKey, "conduitKey"),
        totalOriginalConsiderationItems: normalizeUint(
            parameters.totalOriginalConsiderationItems,
            "totalOriginalConsiderationItems",
        ),
        counter: normalizeUint(parameters.counter, "counter"),
    };
}

export function extractSeaportSellTerms(
    seaportData: SeaportOrderData | null | undefined,
): {
    maker: string;
    contract: string;
    tokenId: string;
    currency: string;
    price: string;
    validFrom: number;
    validUntil: number;
} | null {
    if (!seaportData) return null;

    const nftItem = findSingleNftItem(seaportData.offer);
    if (!nftItem) return null;
    const quote = declaredOrderQuote({
        side: ORDER_SIDE.Sell,
        contract: nftItem.token,
        seaportData,
    });
    if (quote.currency === null || quote.price === null) return null;

    return {
        maker: seaportData.offerer,
        contract: nftItem.token,
        tokenId: nftItem.identifierOrCriteria,
        currency: quote.currency,
        price: quote.price,
        validFrom: toUnixSecondsNumber(seaportData.startTime),
        validUntil: toUnixSecondsNumber(seaportData.endTime),
    };
}

function parseOfferItems(value: unknown): SeaportOrderItem[] {
    if (!Array.isArray(value)) {
        throw new Error("Invalid offer: expected array");
    }

    return value.map((entry, index) => normalizeItem(entry, `offer[${index}]`));
}

function parseConsiderationItems(value: unknown): SeaportConsiderationItem[] {
    if (!Array.isArray(value)) {
        throw new Error("Invalid consideration: expected array");
    }

    return value.map((entry, index) => {
        const item = normalizeItem(entry, `consideration[${index}]`);
        const record = asObject(entry, `consideration[${index}]`);
        return {
            ...item,
            recipient: assertAddress(record.recipient, "recipient"),
        };
    });
}

function normalizeItem(value: unknown, name: string): SeaportOrderItem {
    const item = asObject(value, name);
    return {
        itemType: normalizeUint(item.itemType, `${name}.itemType`),
        token: assertAddress(item.token, `${name}.token`),
        identifierOrCriteria: normalizeUint(
            item.identifierOrCriteria,
            `${name}.identifierOrCriteria`,
        ),
        startAmount: normalizeUint(item.startAmount, `${name}.startAmount`),
        endAmount: normalizeUint(item.endAmount, `${name}.endAmount`),
    };
}

function normalizeUint(value: unknown, name: string): string {
    return toBigInt(value, name).toString();
}

function findSingleNftItem(
    items: SeaportOrderItem[] | SeaportConsiderationItem[],
): SeaportOrderItem | SeaportConsiderationItem | null {
    const nftItems = items.filter((item) => seaportIsNftItem(item.itemType));
    if (nftItems.length !== 1) {
        return null;
    }
    return nftItems[0] ?? null;
}

function toUnixSecondsNumber(value: string): number {
    return Number(BigInt(value));
}
