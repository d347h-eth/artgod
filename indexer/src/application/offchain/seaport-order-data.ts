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

const NFT_ITEM_TYPES = new Set(["2", "3", "4", "5"]);
const PAYMENT_ITEM_TYPES = new Set(["0", "1"]);

export function normalizeSeaportOrderData(
    payload: Record<string, unknown>,
): SeaportOrderData | null {
    const protocolAddress = payload.protocol_address ?? payload.protocolAddress;
    const protocolData = getOpenSeaProtocolData(payload);
    if (!protocolAddress || !protocolData) {
        return null;
    }

    return decodeSeaportComponents(protocolAddress, protocolData);
}

/** Both adapters use the identical signed array and exact integer representation.
 * VVV omits the unsigned count. Its adapter checks the hash and signer before
 * accepting this candidate as a settlement identity. */
export function decodeSeaportComponents(
    protocolAddress: unknown,
    envelope: unknown,
): SeaportOrderData {
    const normalizedProtocolAddress = assertAddress(
        protocolAddress,
        "protocol_address",
    );
    const protocol = asObject(envelope, "order");
    const parameters = asObject(protocol.parameters, "order.parameters");
    const consideration = parseConsiderationItems(parameters.consideration);
    return {
        protocolAddress: normalizedProtocolAddress,
        signature: parseOptionalString(
            protocol.signature,
            "protocol_data.signature",
        ),
        offerer: assertAddress(parameters.offerer, "offerer"),
        zone: assertAddress(parameters.zone, "zone"),
        offer: parseOfferItems(parameters.offer),
        consideration,
        orderType: normalizeUint(parameters.orderType, "orderType"),
        startTime: normalizeUint(parameters.startTime, "startTime"),
        endTime: normalizeUint(parameters.endTime, "endTime"),
        zoneHash: assertString(parameters.zoneHash, "zoneHash"),
        salt: normalizeUint(parameters.salt, "salt"),
        conduitKey: assertString(parameters.conduitKey, "conduitKey"),
        totalOriginalConsiderationItems: normalizeUint(
            parameters.totalOriginalConsiderationItems ?? consideration.length,
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
    const payment = sumFixedCurrencyItems(seaportData.consideration);
    if (!nftItem || !payment) {
        return null;
    }

    return {
        maker: seaportData.offerer,
        contract: nftItem.token,
        tokenId: nftItem.identifierOrCriteria,
        currency: payment.currency,
        price: payment.amount,
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
    if (typeof value === "number" && !Number.isSafeInteger(value))
        throw new Error("Unsafe integer in " + name);
    const amount = toBigInt(value, name);
    if (amount < 0n || amount >= 2n ** 256n)
        throw new Error("Invalid unsigned integer in " + name);
    return amount.toString();
}

function findSingleNftItem(
    items: SeaportOrderItem[] | SeaportConsiderationItem[],
): SeaportOrderItem | SeaportConsiderationItem | null {
    const nftItems = items.filter((item) => NFT_ITEM_TYPES.has(item.itemType));
    if (nftItems.length !== 1) {
        return null;
    }
    return nftItems[0] ?? null;
}

function sumFixedCurrencyItems(
    items: SeaportOrderItem[] | SeaportConsiderationItem[],
): { currency: string; amount: string } | null {
    const paymentItems = items.filter((item) =>
        PAYMENT_ITEM_TYPES.has(item.itemType),
    );
    if (paymentItems.length === 0) {
        return null;
    }

    const [first] = paymentItems;
    if (!first) return null;
    const currency = first.token.toLowerCase();

    let total = 0n;
    for (const item of paymentItems) {
        if (item.token.toLowerCase() !== currency) {
            return null;
        }
        if (item.startAmount !== item.endAmount) {
            return null;
        }
        total += BigInt(item.startAmount);
    }

    return {
        currency,
        amount: total.toString(),
    };
}

function toUnixSecondsNumber(value: string): number {
    return Number(BigInt(value));
}
