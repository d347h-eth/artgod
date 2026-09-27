// ERC721 token IDs are unsigned 256-bit integers, serialized as decimal strings.
export const EVM_TOKEN_ID_MAX = (1n << 256n) - 1n;
const EVM_TOKEN_ID_DECIMAL_LENGTH = EVM_TOKEN_ID_MAX.toString().length;

/** Normalize an untrusted token ID without allowing hexadecimal or lossy numbers. */
export function normalizeEvmTokenId(value: unknown): string | null {
    if (typeof value !== "string") return null;
    const text = value.trim();
    if (!/^\d+$/.test(text) || text.length > EVM_TOKEN_ID_DECIMAL_LENGTH) {
        return null;
    }
    const tokenId = BigInt(text);
    return tokenId <= EVM_TOKEN_ID_MAX ? tokenId.toString() : null;
}
