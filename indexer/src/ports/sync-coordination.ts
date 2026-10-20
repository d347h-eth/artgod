import type {
    ChainBlockReference,
    ChainSyncCheckpoint,
    CollectionAppliedProgress,
    SyncBlockHeader,
} from "../domain/chain-sync.js";
import type { SyncApplication } from "../domain/sync-work.js";

export type CollectionBaseCandidate = {
    checkpoint: ChainSyncCheckpoint;
    collectionId: number;
    anchor: Pick<SyncBlockHeader, "number" | "hash">;
    /** Null below the shared base: the owner must freshly verify this identity. */
    acceptedHeader: SyncBlockHeader | null;
};

/** Bounded selection and retry scheduling for the one current-state owner.
 * Coverage rows and queued ranges never authorize selection of a later prefix. */
export interface SyncCoordinationPort {
    firstInstalledBase(
        chainId: number,
    ): (ChainBlockReference & { checkpoint: ChainSyncCheckpoint }) | null;
    unacceptedCollectionBases(
        chainId: number,
        now: number,
        limit: number,
    ): CollectionBaseCandidate[];
    recordBaseAttempt(
        base: CollectionBaseCandidate,
        now: number,
        retryAt: number,
    ): void;
    nextCollectionCatchup(
        chainId: number,
        now: number,
    ): CollectionAppliedProgress | null;
    sharedDue(chainId: number, now: number): boolean;
    canAdvance(chainId: number): boolean;
    recordAttempt(
        application: SyncApplication,
        now: number,
        retryAt: number,
    ): void;
}
