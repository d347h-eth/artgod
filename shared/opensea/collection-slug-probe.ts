// Status values returned when probing one OpenSea collection slug.
export const OPENSEA_COLLECTION_SLUG_PROBE_STATUS = {
    Disabled: "disabled",
    Found: "found",
    Missing: "missing",
} as const;

export type OpenSeaCollectionSlugProbeStatus =
    (typeof OPENSEA_COLLECTION_SLUG_PROBE_STATUS)[keyof typeof OPENSEA_COLLECTION_SLUG_PROBE_STATUS];

// The first and last token are the only collection-scope representatives accepted by a probe.
export const OPENSEA_COLLECTION_SLUG_PROBE_MAX_VERIFICATION_TOKEN_IDS = 2;

// Returns the first and last token IDs that bind one continuous range to OpenSea.
export function resolveOpenSeaTokenRangeBoundaryIds(input: {
    startTokenId: string;
    totalSupply: number;
}): string[] {
    const rawStartTokenId = input.startTokenId.trim();
    if (
        !/^\d+$/.test(rawStartTokenId) ||
        !Number.isSafeInteger(input.totalSupply) ||
        input.totalSupply <= 0
    ) {
        return [];
    }
    const startTokenId = BigInt(rawStartTokenId).toString();
    const endTokenId = (
        BigInt(startTokenId) + BigInt(input.totalSupply - 1)
    ).toString();
    return startTokenId === endTokenId
        ? [startTokenId]
        : [startTokenId, endTokenId];
}

// Returns at most the lowest and highest token IDs from an explicit scope.
export function resolveOpenSeaExplicitTokenBoundaryIds(
    tokenIds: readonly string[],
): string[] {
    const normalized = [
        ...new Set(
            tokenIds.flatMap((tokenId) => {
                const value = tokenId.trim();
                return /^\d+$/.test(value) ? [BigInt(value).toString()] : [];
            }),
        ),
    ].sort((left, right) => {
        const leftValue = BigInt(left);
        const rightValue = BigInt(right);
        return leftValue < rightValue ? -1 : leftValue > rightValue ? 1 : 0;
    });
    const first = normalized[0];
    const last = normalized.at(-1);
    if (!first || !last) return [];
    return first === last ? [first] : [first, last];
}
