import type { OffchainOrderRawPayload } from "../../domain/offchain-jobs.js";
import type { OrderUpsertPayload } from "../../domain/order-jobs.js";

type RawOrderPayload = {
    orderId: string;
    kind: string;
    side: "buy" | "sell";
    maker: string;
    taker?: string | null;
    contract: string;
    tokenId: string;
    price?: string | null;
    currency?: string | null;
    validFrom?: number | null;
    validUntil?: number | null;
};

export function normalizeOffchainOrder(
    raw: OffchainOrderRawPayload,
): OrderUpsertPayload {
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

    const payload = assertObject(raw.payload, "payload");
    const order = toRawOrderPayload(payload);

    return {
        chainId: raw.chainId,
        orderId: order.orderId,
        kind: order.kind,
        side: order.side,
        maker: normalizeAddress(order.maker, "maker"),
        taker: normalizeOptionalAddress(order.taker, "taker"),
        contract: normalizeAddress(order.contract, "contract"),
        tokenId: order.tokenId,
        price: order.price ?? null,
        currency: normalizeOptionalAddress(order.currency, "currency"),
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
        taker: optionalString(value.taker, "taker"),
        contract: assertString(value.contract, "contract"),
        tokenId: assertString(value.tokenId, "tokenId"),
        price: optionalString(value.price, "price"),
        currency: optionalString(value.currency, "currency"),
        validFrom: optionalNumber(value.validFrom, "validFrom"),
        validUntil: optionalNumber(value.validUntil, "validUntil"),
    };
}

function assertObject(
    value: unknown,
    name: string,
): Record<string, unknown> {
    if (!value || typeof value !== "object") {
        throw new Error(`Invalid ${name}: expected object`);
    }
    return value as Record<string, unknown>;
}

function assertString(value: unknown, name: string): string {
    if (typeof value !== "string" || value.trim() === "") {
        throw new Error(`Invalid ${name}: expected non-empty string`);
    }
    return value;
}

function assertSide(
    value: unknown,
    name: string,
): "buy" | "sell" {
    if (value === "buy" || value === "sell") return value;
    throw new Error(`Invalid ${name}: expected 'buy' or 'sell'`);
}

function optionalString(value: unknown, name: string): string | null {
    if (value === undefined || value === null) return null;
    if (typeof value !== "string" || value.trim() === "") {
        throw new Error(`Invalid ${name}: expected non-empty string`);
    }
    return value;
}

function optionalNumber(value: unknown, name: string): number | null {
    if (value === undefined || value === null) return null;
    const num =
        typeof value === "number" ? value : Number(String(value));
    if (!Number.isFinite(num)) {
        throw new Error(`Invalid ${name}: expected number`);
    }
    return num;
}

function normalizeAddress(value: string, name: string): string {
    if (!/^0x[a-fA-F0-9]{40}$/.test(value)) {
        throw new Error(`Invalid ${name}: ${value}`);
    }
    return value.toLowerCase();
}

function normalizeOptionalAddress(
    value: string | null | undefined,
    name: string,
): string | null {
    if (!value) return null;
    return normalizeAddress(value, name);
}
