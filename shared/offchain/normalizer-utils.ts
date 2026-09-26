import { isAddress, isHash, toHex } from "viem";

/** Tolerant record access for external payloads; required fields use asObject. */
export function asRecord(value: unknown): Record<string, unknown> {
    return value && typeof value === "object" && !Array.isArray(value)
        ? (value as Record<string, unknown>)
        : {};
}

export function asObject(
    value: unknown,
    name: string,
): Record<string, unknown> {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
        throw new Error(`Invalid ${name}: expected object`);
    }
    return value as Record<string, unknown>;
}

export function assertString(value: unknown, name: string): string {
    if (typeof value !== "string" || value.trim() === "") {
        throw new Error(`Invalid ${name}: expected non-empty string`);
    }
    return value;
}

export function assertSide(value: unknown, name: string): "buy" | "sell" {
    if (value === "buy" || value === "sell") return value;
    throw new Error(`Invalid ${name}: expected 'buy' or 'sell'`);
}

export function parseOptionalString(
    value: unknown,
    name: string,
): string | null {
    if (value === undefined || value === null) return null;
    return assertString(value, name);
}

export function parseOptionalNumber(
    value: unknown,
    name: string,
): number | null {
    if (value === undefined || value === null) return null;
    const num = typeof value === "number" ? value : Number(String(value));
    if (!Number.isFinite(num)) {
        throw new Error(`Invalid ${name}: expected number`);
    }
    return num;
}

export function assertAddress(value: unknown, name: string): string {
    const address = tryParseAddress(value);
    if (address === null) throw new Error(`Invalid ${name} address`);
    return address;
}

/** Accepts raw address strings and marketplace account objects. */
export function tryParseAddress(value: unknown): string | null {
    const address = typeof value === "string" ? value : asRecord(value).address;
    return typeof address === "string" && isAddress(address, { strict: false })
        ? address.toLowerCase()
        : null;
}

export function tryParseHash(value: unknown): string | null {
    return typeof value === "string" && isHash(value)
        ? value.toLowerCase()
        : null;
}

export function parseOptionalAddress(
    value: unknown,
    name: string,
): string | null {
    if (value === undefined || value === null) return null;
    return assertAddress(value, name);
}

export function assertPrice(value: unknown, name: string): string {
    if (typeof value === "string") return value;
    if (typeof value === "number" && Number.isFinite(value)) {
        return String(value);
    }
    throw new Error(`Invalid ${name} price`);
}

export function assertPaymentToken(value: unknown, name: string): string {
    const token = asObject(value, name);
    return assertAddress(token.address, `${name}.address`);
}

export function parseTimestamp(value: unknown, name: string): number | null {
    if (value === undefined || value === null) return null;
    const raw = typeof value === "string" ? value : String(value);
    const ms = Date.parse(raw);
    if (!Number.isFinite(ms)) {
        throw new Error(`Invalid ${name} timestamp`);
    }
    return Math.floor(ms / 1000);
}

export function toBigInt(value: unknown, name: string): bigint {
    if (typeof value === "bigint") return value;
    if (typeof value === "number" && Number.isFinite(value)) {
        return BigInt(value);
    }
    if (typeof value === "string" && value.trim() !== "") {
        return BigInt(value);
    }
    throw new Error(`Invalid ${name}: expected bigint-compatible value`);
}

export function normalizeCriteriaRoot(
    value: unknown,
    name: string,
): string | null {
    if (value === undefined || value === null) return null;
    if (typeof value === "string" && value.trim() === "") return null;

    if (typeof value === "string") {
        if (value.startsWith("0x")) return value.toLowerCase();
        return toHex(BigInt(value), { size: 32 });
    }

    if (typeof value === "number" && Number.isFinite(value)) {
        return toHex(BigInt(value), { size: 32 });
    }

    if (typeof value === "bigint") {
        return toHex(value, { size: 32 });
    }

    throw new Error(`Invalid ${name}: expected criteria root`);
}
