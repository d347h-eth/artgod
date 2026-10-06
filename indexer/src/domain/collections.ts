// Collection identity is the primary anchor of the indexer. Everything
// downstream should depend on this domain model, not on raw contract-address
// heuristics or ad hoc scope-kind string checks.
import type {
    CollectionStatus,
    OpenSeaCollectionStatus,
    OpenSeaStreamIngestionStatus,
} from "@artgod/shared/types";
import {
    COLLECTION_STATUS,
    OPENSEA_STREAM_INGESTION_STATUS,
} from "@artgod/shared/types";

// Collection standards supported by the on-chain indexer and order domain.
export const COLLECTION_STANDARD = {
    Erc721: "erc721",
    Erc1155: "erc1155",
} as const;

export type CollectionStandard =
    (typeof COLLECTION_STANDARD)[keyof typeof COLLECTION_STANDARD];

import {
    CollectionTokenScope,
    type ContinuousTokenRange,
} from "@artgod/shared/collections/token-scope";
export { CollectionTokenScope } from "@artgod/shared/collections/token-scope";

// This is the post-anchor part of a range that may update current state.
export type CurrentStateProjectionWindow = {
    fromBlock: number;
    toBlock: number;
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
    openseaStreamIngestionStatus: OpenSeaStreamIngestionStatus;
    openseaReadyAt: string | null;
    openseaSnapshotStartedAt: string | null;
    openseaSnapshotCompletedAt: string | null;
    openseaReconcileStartedAt: string | null;
    openseaReconcileCompletedAt: string | null;
    openseaLastStreamEventAt: string | null;
    openseaLastStreamHealthyAt: string | null;
    openseaLastError: string | null;
};

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
        public readonly openseaStreamIngestionStatus: OpenSeaStreamIngestionStatus,
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
            input.openseaStreamIngestionStatus,
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
    static hasBootstrapAnchorValue(
        bootstrapAnchorBlock: number | null,
    ): boolean {
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
        return CollectionRecord.hasBootstrapAnchorValue(
            this.bootstrapAnchorBlock,
        );
    }

    // Automatic repair owns the inclusive anchor-to-head window of live
    // collections. Bootstrap progress and global block presence are not proof
    // that this collection has complete coverage.
    gapRepairWindow(
        headBlock: number,
    ): { fromBlock: number; toBlock: number } | null {
        const anchor = this.bootstrapAnchorBlock;
        if (
            this.status !== COLLECTION_STATUS.Live ||
            anchor === null ||
            !Number.isSafeInteger(anchor) ||
            anchor < 1 ||
            !Number.isSafeInteger(headBlock) ||
            anchor > headBlock
        ) {
            return null;
        }
        return { fromBlock: anchor, toBlock: headBlock };
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

    // True when the operator allows OpenSea stream events to enter the local queue.
    allowsOpenSeaStreamIngestion(): boolean {
        return (
            this.openseaStreamIngestionStatus ===
            OPENSEA_STREAM_INGESTION_STATUS.Enabled
        );
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
            openseaStreamIngestionStatus: this.openseaStreamIngestionStatus,
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
