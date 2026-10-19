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
    ): void;
    acceptCollectionBase(
        checkpoint: ChainSyncCheckpoint,
        collectionId: number,
        anchor: SyncBlockHeader,
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
}
