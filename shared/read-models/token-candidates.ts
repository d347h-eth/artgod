// Shared token-candidate shape used by read-model queries that prefilter token ids.
export type TokenCandidates = {
    tokenIds: string[] | null;
    isEmpty: boolean;
    candidateTokenIdsCount?: number;
};

// Builds a token-id predicate for callers that already resolved candidates.
export function buildTokenCandidateWhereClauses(params: {
    tokenIds: string[] | null;
    tokenColumnSql: string;
}): {
    whereClauses: string[];
    values: unknown[];
} {
    if (params.tokenIds === null) {
        return { whereClauses: [], values: [] };
    }
    if (params.tokenIds.length === 0) {
        return { whereClauses: ["1 = 0"], values: [] };
    }

    return {
        whereClauses: [
            `${params.tokenColumnSql} IN (${params.tokenIds
                .map(() => "?")
                .join(", ")})`,
        ],
        values: params.tokenIds,
    };
}

// Intersects token-id candidate sets, starting from the smallest set.
export function intersectTokenIdSets(candidateSets: string[][]): string[] {
    const [firstSet, ...remainingSets] = candidateSets
        .slice()
        .sort((left, right) => left.length - right.length);
    if (!firstSet) return [];

    let tokenIds = firstSet;
    for (const candidateSet of remainingSets) {
        const allowed = new Set(candidateSet);
        tokenIds = tokenIds.filter((tokenId) => allowed.has(tokenId));
        if (tokenIds.length === 0) return [];
    }

    return tokenIds;
}
