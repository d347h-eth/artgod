export function asObject(
    value: unknown,
    name: string,
): Record<string, unknown> {
    if (!value || typeof value !== "object") {
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

export function assertSide(
    value: unknown,
    name: string,
): "buy" | "sell" {
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
    const num =
        typeof value === "number" ? value : Number(String(value));
    if (!Number.isFinite(num)) {
        throw new Error(`Invalid ${name}: expected number`);
    }
    return num;
}

export function assertAddress(value: unknown, name: string): string {
    const address =
        typeof value === "string" ? value : asObject(value, name).address;
    if (typeof address !== "string") {
        throw new Error(`Invalid ${name} address`);
    }
    if (!/^0x[a-fA-F0-9]{40}$/.test(address)) {
        throw new Error(`Invalid ${name} address: ${address}`);
    }
    return address.toLowerCase();
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

export function parseNftId(
    value: unknown,
): { contract: string; tokenId: string } {
    const item = asObject(value, "item");
    const nftId = assertString(item.nft_id, "item.nft_id");
    const parts = nftId.split("/");
    if (parts.length < 3) {
        throw new Error(`Invalid nft_id: ${nftId}`);
    }
    const contract = assertAddress(parts[1], "item.nft_id.contract");
    const tokenId = parts.slice(2).join("/");
    if (!tokenId) {
        throw new Error(`Invalid nft_id tokenId: ${nftId}`);
    }
    return { contract, tokenId };
}
