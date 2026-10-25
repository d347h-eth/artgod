import type {
    AppliedChainProgress,
    ChainBlockReference,
    ChainSyncCheckpoint,
    CollectionAppliedProgress,
    SyncBlockHeader,
    ValidationCheckpoint,
} from "../domain/chain-sync.js";
import type { PendingCanonicalCheck } from "../domain/canonical-check.js";

/** Captured before the remote head read. Later observations await another sample. */
export type ChainHeadSampleRequest = {
    checkpoint: ChainSyncCheckpoint;
    admissionWatermark: number;
};

export type ChainHeadSample = ChainBlockReference & {
    revision: number;
    sampledAt: number;
};

/** Read-side authority supplied to validation, never an authority to advance sync. */
export interface ValidationCheckpointPort {
    validationCheckpoint(
        chainId: number,
        collectionId: number,
        barrier?: ChainBlockReference | null,
    ): ValidationCheckpoint | null;
    assertValidationCheckpoint(checkpoint: ValidationCheckpoint): void;
}

/** The sync coordinator owns these transitions. Effects and advance share the
 * existing range-commit transaction; no RPC or publication belongs in a writer. */
export interface ChainProgressPort extends ValidationCheckpointPort {
    chainProgress(chainId: number): AppliedChainProgress | null;
    collectionProgress(
        chainId: number,
        collectionId: number,
    ): CollectionAppliedProgress | null;
    initializeChain(
        checkpoint: ChainSyncCheckpoint,
        anchor: SyncBlockHeader,
        history?: readonly SyncBlockHeader[],
    ): void;
    acceptCollectionBase(
        checkpoint: ChainSyncCheckpoint,
        collectionId: number,
        anchor: SyncBlockHeader,
        bootstrapRunId?: number,
    ): void;
    captureHeadSample(chainId: number): ChainHeadSampleRequest;
    recordHeadSample(
        request: ChainHeadSampleRequest,
        head: SyncBlockHeader,
        now: number,
    ): void;
    headTarget(chainId: number): ChainHeadSample | null;
    admissionBarrier(
        chainId: number,
        admissionSequence: number,
    ): ChainHeadSample | null;
    retainDispute(check: PendingCanonicalCheck): void;
    /** Bounded retention pass. Outstanding admission mappings and the current
     * revision's latest watermark remain stable; accepted proofs use scalars. */
    pruneHeadSamples(input: { now: number; limit: number }): {
        examined: number;
        removed: number;
    };
}

/** Range acceptance and effects share one writer. Checking only header presence
 * is insufficient to authorize a projection or publish applied progress. */
export interface AppliedRangeProgressPort {
    /** Requires the caller's collection predecessor assertion. Below-shared-base
     * replay connects an installed snapshot; overlapping shared identities match. */
    assertCollectionReplayRange(
        checkpoint: ChainSyncCheckpoint,
        blocks: readonly SyncBlockHeader[],
    ): void;
    assertChainRange(
        expected: AppliedChainProgress,
        blocks: readonly SyncBlockHeader[],
    ): void;
    advanceChain(
        expected: AppliedChainProgress,
        blocks: readonly SyncBlockHeader[],
    ): void;
    assertCollectionRange(
        expected: CollectionAppliedProgress & {
            bootstrapRunId?: number | null;
        },
        blocks: readonly SyncBlockHeader[],
    ): void;
    advanceCollection(
        expected: CollectionAppliedProgress & {
            bootstrapRunId?: number | null;
        },
        blocks: readonly SyncBlockHeader[],
    ): void;
    assertHistoricalRange(
        checkpoint: ChainSyncCheckpoint,
        blocks: readonly SyncBlockHeader[],
    ): void;
}
