import { EVM_TOKEN_ID_MAX, normalizeEvmTokenId } from "../evm/token-id.js";

// Persisted collection-scope vocabulary, also used by extension matching.
export const COLLECTION_TOKEN_SCOPE_KIND = {
    AllContractTokens: "contract_all_tokens",
    TokenRange: "token_range",
    ExplicitTokenIds: "explicit_token_ids",
} as const;

type ScopeValue =
    | { kind: typeof COLLECTION_TOKEN_SCOPE_KIND.AllContractTokens }
    | { kind: typeof COLLECTION_TOKEN_SCOPE_KIND.ExplicitTokenIds }
    | {
          kind: typeof COLLECTION_TOKEN_SCOPE_KIND.TokenRange;
          startTokenId: string;
          tokenCount: number;
      };

type SerializedCollectionScope = {
    tokenScopeKind: string;
    scopeStartTokenId: string | null;
    scopeTotalSupply: number | null;
};

export type ContinuousTokenRange = { fromTokenId: string; toTokenId: string };

/** The declared collection universe, independent of currently minted inventory. */
export class CollectionTokenScope {
    private constructor(private readonly value: ScopeValue) {}

    static fromPersistence(
        input: SerializedCollectionScope,
    ): CollectionTokenScope {
        switch (input.tokenScopeKind) {
            case COLLECTION_TOKEN_SCOPE_KIND.AllContractTokens:
                return CollectionTokenScope.allContractTokens();
            case COLLECTION_TOKEN_SCOPE_KIND.ExplicitTokenIds:
                return CollectionTokenScope.explicitTokenIds();
            case COLLECTION_TOKEN_SCOPE_KIND.TokenRange:
                return CollectionTokenScope.tokenRange(
                    input.scopeStartTokenId,
                    input.scopeTotalSupply,
                );
            default:
                throw new Error(
                    `Unknown collection token scope kind: ${input.tokenScopeKind}`,
                );
        }
    }

    static allContractTokens(): CollectionTokenScope {
        return new CollectionTokenScope({
            kind: COLLECTION_TOKEN_SCOPE_KIND.AllContractTokens,
        });
    }

    static explicitTokenIds(): CollectionTokenScope {
        return new CollectionTokenScope({
            kind: COLLECTION_TOKEN_SCOPE_KIND.ExplicitTokenIds,
        });
    }

    static tokenRange(
        start: string | null,
        count: number | null,
    ): CollectionTokenScope {
        const startTokenId = normalizeEvmTokenId(start);
        if (startTokenId === null || count === null) {
            throw new Error(
                "Token-range scope requires a valid start token and count",
            );
        }
        if (!Number.isSafeInteger(count) || count <= 0) {
            throw new Error(
                "Token-range scope requires a positive integer count",
            );
        }
        if (BigInt(startTokenId) + BigInt(count - 1) > EVM_TOKEN_ID_MAX) {
            throw new Error("Token range exceeds the largest token ID");
        }
        return new CollectionTokenScope({
            kind: COLLECTION_TOKEN_SCOPE_KIND.TokenRange,
            startTokenId,
            tokenCount: count,
        });
    }

    get scopeStartTokenId(): string | null {
        return this.value.kind === COLLECTION_TOKEN_SCOPE_KIND.TokenRange
            ? this.value.startTokenId
            : null;
    }

    get scopeTotalSupply(): number | null {
        return this.value.kind === COLLECTION_TOKEN_SCOPE_KIND.TokenRange
            ? this.value.tokenCount
            : null;
    }

    isAllContractTokensScope(): boolean {
        return (
            this.value.kind === COLLECTION_TOKEN_SCOPE_KIND.AllContractTokens
        );
    }

    isTokenRangeScope(): boolean {
        return this.value.kind === COLLECTION_TOKEN_SCOPE_KIND.TokenRange;
    }

    isExplicitTokenIdsScope(): boolean {
        return this.value.kind === COLLECTION_TOKEN_SCOPE_KIND.ExplicitTokenIds;
    }

    containsToken(
        tokenId: string,
        hasExplicitToken: (id: string) => boolean = () => false,
    ): boolean {
        const normalized = normalizeEvmTokenId(tokenId);
        if (normalized === null) return false;
        switch (this.value.kind) {
            case COLLECTION_TOKEN_SCOPE_KIND.AllContractTokens:
                return true;
            case COLLECTION_TOKEN_SCOPE_KIND.ExplicitTokenIds:
                return hasExplicitToken(normalized);
            case COLLECTION_TOKEN_SCOPE_KIND.TokenRange: {
                const start = BigInt(this.value.startTokenId);
                const id = BigInt(normalized);
                return (
                    id >= start && id < start + BigInt(this.value.tokenCount)
                );
            }
        }
    }

    intersectContinuousRange(
        fromTokenId: string,
        toTokenId: string,
    ): ContinuousTokenRange | null {
        const from = normalizeEvmTokenId(fromTokenId);
        const to = normalizeEvmTokenId(toTokenId);
        if (from === null || to === null || BigInt(from) > BigInt(to))
            return null;
        switch (this.value.kind) {
            case COLLECTION_TOKEN_SCOPE_KIND.ExplicitTokenIds:
                return null;
            case COLLECTION_TOKEN_SCOPE_KIND.AllContractTokens:
                return { fromTokenId: from, toTokenId: to };
            case COLLECTION_TOKEN_SCOPE_KIND.TokenRange: {
                const start = BigInt(this.value.startTokenId);
                const end = start + BigInt(this.value.tokenCount - 1);
                const lower = BigInt(from) > start ? BigInt(from) : start;
                const upper = BigInt(to) < end ? BigInt(to) : end;
                return lower > upper
                    ? null
                    : {
                          fromTokenId: lower.toString(),
                          toTokenId: upper.toString(),
                      };
            }
        }
    }

    toPersistence() {
        return {
            tokenScopeKind: this.value.kind,
            scopeStartTokenId: this.scopeStartTokenId,
            scopeTotalSupply: this.scopeTotalSupply,
        };
    }
}
