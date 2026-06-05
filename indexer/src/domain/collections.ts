// Collection identity is the primary anchor of the indexer. Everything
// downstream should depend on this domain model, not on raw contract-address
// heuristics or ad hoc scope-kind string checks.
import type { CollectionStatus } from "@artgod/shared/types";

// Collection standards supported by the on-chain indexer and order domain.
export const COLLECTION_STANDARD = {
    Erc721: "erc721",
    Erc1155: "erc1155",
} as const;

export type CollectionStandard =
    (typeof COLLECTION_STANDARD)[keyof typeof COLLECTION_STANDARD];

export type OpenSeaCollectionStatus =
    | "pending"
    | "identity_running"
    | "subscribing"
    | "snapshot_pending"
    | "snapshot_running"
    | "ready"
    | "retrying"
    | "failed";

// Keep raw scope literals private to this module.
const TOKEN_SCOPE_KIND = {
    AllContractTokens: "contract_all_tokens",
    TokenRange: "token_range",
    ExplicitTokenIds: "explicit_token_ids",
} as const;

type TokenScopeKind = (typeof TOKEN_SCOPE_KIND)[keyof typeof TOKEN_SCOPE_KIND];

type ContinuousTokenRange = {
    fromTokenId: string;
    toTokenId: string;
};

// This is the post-anchor part of a range that may update current state.
export type CurrentStateProjectionWindow = {
    fromBlock: number;
    toBlock: number;
};

// Serialized scope shape used only at adapter boundaries. Raw persistence
// carries stringly-typed scope kinds; the domain wraps that data in
// CollectionTokenScope before business logic touches it.
type SerializedCollectionScope = {
    tokenScopeKind: string;
    scopeStartTokenId: string | null;
    scopeTotalSupply: number | null;
};

// Serialized collection snapshot used for DB/adapter translation only. This is
// intentionally separate from CollectionRecord so persistence concerns stay out
// of the main business model.
type SerializedCollectionRecord = {
    chainId: number;
    id: number;
    slug: string;
    address: string;
    standard: CollectionStandard;
    status: CollectionStatus;
    tokenScopeKind: string;
    scopeStartTokenId: string | null;
    scopeTotalSupply: number | null;
    deploymentBlock: number | null;
    bootstrapAnchorBlock: number | null;
    bootstrapStartedAt: string | null;
    bootstrapFinishedAt: string | null;
    bootstrapLastSyncedBlock: number | null;
    openseaSlug: string | null;
    openseaStatus: OpenSeaCollectionStatus | null;
    openseaReadyAt: string | null;
    openseaSnapshotStartedAt: string | null;
    openseaSnapshotCompletedAt: string | null;
    openseaReconcileStartedAt: string | null;
    openseaReconcileCompletedAt: string | null;
    openseaLastStreamEventAt: string | null;
    openseaLastStreamHealthyAt: string | null;
    openseaLastError: string | null;
};

// CollectionTokenScope owns all scope semantics. Consumers should use these
// methods instead of branching on raw scope-kind values.
export class CollectionTokenScope {
    private constructor(
        private readonly kind: TokenScopeKind,
        public readonly scopeStartTokenId: string | null,
        public readonly scopeTotalSupply: number | null,
    ) {}

    static fromPersistence(
        input: SerializedCollectionScope,
    ): CollectionTokenScope {
        switch (input.tokenScopeKind) {
            case TOKEN_SCOPE_KIND.AllContractTokens:
                return CollectionTokenScope.allContractTokens();
            case TOKEN_SCOPE_KIND.TokenRange:
                return CollectionTokenScope.tokenRange(
                    input.scopeStartTokenId,
                    input.scopeTotalSupply,
                );
            case TOKEN_SCOPE_KIND.ExplicitTokenIds:
                return CollectionTokenScope.explicitTokenIds();
            default:
                throw new Error(
                    `Unknown collection token scope kind: ${input.tokenScopeKind}`,
                );
        }
    }

    static allContractTokens(): CollectionTokenScope {
        return new CollectionTokenScope(
            TOKEN_SCOPE_KIND.AllContractTokens,
            null,
            null,
        );
    }

    // This scope covers one continuous token range.
    static tokenRange(
        scopeStartTokenId: string | null,
        scopeTotalSupply: number | null,
    ): CollectionTokenScope {
        if (scopeStartTokenId === null || scopeTotalSupply === null) {
            throw new Error(
                "Token-range scope requires start token and supply",
            );
        }
        if (scopeTotalSupply <= 0) {
            throw new Error("Token-range scope requires positive supply");
        }
        return new CollectionTokenScope(
            TOKEN_SCOPE_KIND.TokenRange,
            scopeStartTokenId,
            scopeTotalSupply,
        );
    }

    static explicitTokenIds(): CollectionTokenScope {
        return new CollectionTokenScope(
            TOKEN_SCOPE_KIND.ExplicitTokenIds,
            null,
            null,
        );
    }

    // Use these helpers instead of raw scope-kind checks.
    isAllContractTokensScope(): boolean {
        return this.kind === TOKEN_SCOPE_KIND.AllContractTokens;
    }

    isTokenRangeScope(): boolean {
        return this.kind === TOKEN_SCOPE_KIND.TokenRange;
    }

    isExplicitTokenIdsScope(): boolean {
        return this.kind === TOKEN_SCOPE_KIND.ExplicitTokenIds;
    }

    containsToken(
        tokenId: string,
        hasExplicitToken: (tokenId: string) => boolean = () => false,
    ): boolean {
        // Explicit-token membership comes from the caller.
        if (this.isAllContractTokensScope()) {
            return true;
        }

        if (this.isExplicitTokenIdsScope()) {
            return hasExplicitToken(tokenId);
        }

        const scopeStartTokenId = this.scopeStartTokenId;
        const scopeTotalSupply = this.scopeTotalSupply;
        if (scopeStartTokenId === null || scopeTotalSupply === null) {
            return false;
        }

        const start = BigInt(scopeStartTokenId);
        const end = start + BigInt(scopeTotalSupply - 1);
        const value = BigInt(tokenId);
        return value >= start && value <= end;
    }

    // Intersect a decoded token range with this scope.
    intersectContinuousRange(
        fromTokenId: string,
        toTokenId: string,
    ): ContinuousTokenRange | null {
        if (this.isExplicitTokenIdsScope()) {
            return null;
        }

        if (this.isAllContractTokensScope()) {
            return {
                fromTokenId,
                toTokenId,
            };
        }

        const scopeStartTokenId = this.scopeStartTokenId;
        const scopeTotalSupply = this.scopeTotalSupply;
        if (scopeStartTokenId === null || scopeTotalSupply === null) {
            return null;
        }

        const rangeStart = BigInt(fromTokenId);
        const rangeEnd = BigInt(toTokenId);
        const scopeStart = BigInt(scopeStartTokenId);
        const scopeEnd = scopeStart + BigInt(scopeTotalSupply - 1);
        const intersectStart =
            scopeStart > rangeStart ? scopeStart : rangeStart;
        const intersectEnd = scopeEnd < rangeEnd ? scopeEnd : rangeEnd;
        if (intersectStart > intersectEnd) {
            return null;
        }

        return {
            fromTokenId: intersectStart.toString(),
            toTokenId: intersectEnd.toString(),
        };
    }

    toPersistence(): SerializedCollectionScope {
        return {
            tokenScopeKind: this.kind,
            scopeStartTokenId: this.scopeStartTokenId,
            scopeTotalSupply: this.scopeTotalSupply,
        };
    }
}

// CollectionRecord is the canonical business model for collection identity in
// the indexer runtime. It exposes scope behavior explicitly so callers do not
// re-implement scope rules in random adapters/workers.
export class CollectionRecord {
    private constructor(
        public readonly chainId: number,
        public readonly id: number,
        public readonly slug: string,
        public readonly address: string,
        public readonly standard: CollectionStandard,
        public readonly status: CollectionStatus,
        private readonly scope: CollectionTokenScope,
        public readonly deploymentBlock: number | null,
        public readonly bootstrapAnchorBlock: number | null,
        public readonly bootstrapStartedAt: string | null,
        public readonly bootstrapFinishedAt: string | null,
        public readonly bootstrapLastSyncedBlock: number | null,
        public readonly openseaSlug: string | null,
        public readonly openseaStatus: OpenSeaCollectionStatus | null,
        public readonly openseaReadyAt: string | null,
        public readonly openseaSnapshotStartedAt: string | null,
        public readonly openseaSnapshotCompletedAt: string | null,
        public readonly openseaReconcileStartedAt: string | null,
        public readonly openseaReconcileCompletedAt: string | null,
        public readonly openseaLastStreamEventAt: string | null,
        public readonly openseaLastStreamHealthyAt: string | null,
        public readonly openseaLastError: string | null,
    ) {}

    static fromPersistence(
        input: SerializedCollectionRecord,
    ): CollectionRecord {
        return new CollectionRecord(
            input.chainId,
            input.id,
            input.slug,
            input.address,
            input.standard,
            input.status,
            CollectionTokenScope.fromPersistence({
                tokenScopeKind: input.tokenScopeKind,
                scopeStartTokenId: input.scopeStartTokenId,
                scopeTotalSupply: input.scopeTotalSupply,
            }),
            input.deploymentBlock,
            input.bootstrapAnchorBlock,
            input.bootstrapStartedAt,
            input.bootstrapFinishedAt,
            input.bootstrapLastSyncedBlock,
            input.openseaSlug,
            input.openseaStatus,
            input.openseaReadyAt,
            input.openseaSnapshotStartedAt,
            input.openseaSnapshotCompletedAt,
            input.openseaReconcileStartedAt,
            input.openseaReconcileCompletedAt,
            input.openseaLastStreamEventAt,
            input.openseaLastStreamHealthyAt,
            input.openseaLastError,
        );
    }

    isAllContractTokensScope(): boolean {
        return this.scope.isAllContractTokensScope();
    }

    isTokenRangeScope(): boolean {
        return this.scope.isTokenRangeScope();
    }

    isExplicitTokenIdsScope(): boolean {
        return this.scope.isExplicitTokenIdsScope();
    }

    // True when current-state projection is anchored.
    static hasBootstrapAnchorValue(bootstrapAnchorBlock: number | null): boolean {
        return bootstrapAnchorBlock !== null;
    }

    // Current state only moves forward after the anchor block.
    static canProjectCurrentStateAtBlock(
        bootstrapAnchorBlock: number | null,
        blockNumber: number | null | undefined,
    ): boolean {
        if (blockNumber === null || blockNumber === undefined) {
            return true;
        }
        if (bootstrapAnchorBlock === null) {
            return false;
        }

        return blockNumber > bootstrapAnchorBlock;
    }

    // Return the post-anchor part of a sync range.
    static intersectCurrentStateWindowForAnchor(
        bootstrapAnchorBlock: number | null,
        fromBlock: number,
        toBlock: number,
    ): CurrentStateProjectionWindow | null {
        if (bootstrapAnchorBlock === null) {
            return null;
        }

        const intersectFrom = Math.max(fromBlock, bootstrapAnchorBlock + 1);
        if (intersectFrom > toBlock) {
            return null;
        }

        return {
            fromBlock: intersectFrom,
            toBlock,
        };
    }

    // Instance form of the anchor helpers.
    hasBootstrapAnchor(): boolean {
        return CollectionRecord.hasBootstrapAnchorValue(this.bootstrapAnchorBlock);
    }

    canProjectCurrentStateAt(blockNumber: number): boolean {
        return CollectionRecord.canProjectCurrentStateAtBlock(
            this.bootstrapAnchorBlock,
            blockNumber,
        );
    }

    intersectCurrentStateWindow(
        fromBlock: number,
        toBlock: number,
    ): CurrentStateProjectionWindow | null {
        return CollectionRecord.intersectCurrentStateWindowForAnchor(
            this.bootstrapAnchorBlock,
            fromBlock,
            toBlock,
        );
    }

    // True when the whole range is at or before the settled bootstrap anchor.
    isRangeAtOrBeforeBootstrapAnchor(
        fromBlock: number,
        toBlock: number,
    ): boolean {
        if (fromBlock > toBlock) {
            return false;
        }
        if (this.bootstrapAnchorBlock === null) {
            return false;
        }
        return toBlock <= this.bootstrapAnchorBlock;
    }

    containsTokenInScope(
        tokenId: string,
        hasExplicitToken: (tokenId: string) => boolean = () => false,
    ): boolean {
        return this.scope.containsToken(tokenId, hasExplicitToken);
    }

    // Intersect a decoded range with this collection scope.
    intersectContinuousTokenRange(
        fromTokenId: string,
        toTokenId: string,
    ): ContinuousTokenRange | null {
        return this.scope.intersectContinuousRange(fromTokenId, toTokenId);
    }

    get scopeStartTokenId(): string | null {
        return this.scope.scopeStartTokenId;
    }

    get scopeTotalSupply(): number | null {
        return this.scope.scopeTotalSupply;
    }

    // Adapters can serialize the rich domain object back into plain scalar data
    // for SQL writes without leaking raw persistence semantics to callers.
    toPersistence(): SerializedCollectionRecord {
        const scope = this.scope.toPersistence();
        return {
            chainId: this.chainId,
            id: this.id,
            slug: this.slug,
            address: this.address,
            standard: this.standard,
            status: this.status,
            tokenScopeKind: scope.tokenScopeKind,
            scopeStartTokenId: scope.scopeStartTokenId,
            scopeTotalSupply: scope.scopeTotalSupply,
            deploymentBlock: this.deploymentBlock,
            bootstrapAnchorBlock: this.bootstrapAnchorBlock,
            bootstrapStartedAt: this.bootstrapStartedAt,
            bootstrapFinishedAt: this.bootstrapFinishedAt,
            bootstrapLastSyncedBlock: this.bootstrapLastSyncedBlock,
            openseaSlug: this.openseaSlug,
            openseaStatus: this.openseaStatus,
            openseaReadyAt: this.openseaReadyAt,
            openseaSnapshotStartedAt: this.openseaSnapshotStartedAt,
            openseaSnapshotCompletedAt: this.openseaSnapshotCompletedAt,
            openseaReconcileStartedAt: this.openseaReconcileStartedAt,
            openseaReconcileCompletedAt: this.openseaReconcileCompletedAt,
            openseaLastStreamEventAt: this.openseaLastStreamEventAt,
            openseaLastStreamHealthyAt: this.openseaLastStreamHealthyAt,
            openseaLastError: this.openseaLastError,
        };
    }
}

export type CollectionUpsertInput = CollectionRecord;
