export function encodeOpaqueCursor(payload: unknown): string {
    const json = JSON.stringify(payload);
    return Buffer.from(json, "utf8").toString("base64url");
}

export function decodeOpaqueCursor<T>(cursor: string): T {
    const json = Buffer.from(cursor, "base64url").toString("utf8");
    return JSON.parse(json) as T;
}
