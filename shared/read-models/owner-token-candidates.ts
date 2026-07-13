import { db } from "../database/db.js";
import type {
    ApmPort,
    SpanAttributes,
} from "../observability/apm-contract.js";
import { normalizeAddressRef } from "../utils/ref-resolver.js";
import type { TokenCandidates } from "./token-candidates.js";

type TokenIdRow = {
    token_id: string;
};

// Resolves owner-held tokens once so callers can avoid correlated balance checks.
export function resolveOwnerTokenCandidatesWithSpan(params: {
    apm: ApmPort;
    spanName: string;
    spanAttributes: SpanAttributes;
    chainId: number;
    collectionId: number;
    owner?: string;
}): TokenCandidates {
    if (!params.owner) {
        return {
            tokenIds: null,
            isEmpty: false,
        };
    }

    return params.apm.withSyncSpan(
        params.spanName,
        params.spanAttributes,
        () =>
            resolveOwnerTokenCandidates({
                chainId: params.chainId,
                collectionId: params.collectionId,
                owner: normalizeAddressRef(params.owner!),
            }),
    );
}

function resolveOwnerTokenCandidates(params: {
    chainId: number;
    collectionId: number;
    owner: string;
}): TokenCandidates {
    const rows = db.raw
        .prepare(
            "SELECT DISTINCT token_id " +
                "FROM nft_balances " +
                "WHERE chain_id = ? " +
                "AND collection_id = ? " +
                "AND owner = ? " +
                "AND CAST(amount AS INTEGER) > 0 " +
                "ORDER BY token_id",
        )
        .all(params.chainId, params.collectionId, params.owner) as TokenIdRow[];
    const tokenIds = rows.map((row) => row.token_id);

    return {
        tokenIds,
        isEmpty: tokenIds.length === 0,
        candidateTokenIdsCount: tokenIds.length,
    };
}
