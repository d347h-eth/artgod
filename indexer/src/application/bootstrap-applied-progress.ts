import type { ValidationCheckpoint } from "../domain/chain-sync.js";
import type { ChainProgressPort } from "../ports/chain-progress.js";

export type BootstrapAppliedBase = {
    chainId: number;
    collectionId: number;
    anchorBlock: number;
    anchorHash: string;
};

export type BootstrapAppliedProgressPort = Pick<
    ChainProgressPort,
    "collectionProgress" | "validationCheckpoint"
>;

/** Bootstrap completion uses the same accepted current view as validation.
 * Stored history and a selected anchor alone cannot establish readiness. */
export function bootstrapAppliedCheckpoint(
    progress: BootstrapAppliedProgressPort,
    base: BootstrapAppliedBase,
): ValidationCheckpoint | null {
    const collection = progress.collectionProgress(
        base.chainId,
        base.collectionId,
    );
    if (
        !collection ||
        collection.anchor.number !== base.anchorBlock ||
        collection.anchor.hash !== base.anchorHash
    )
        return null;
    const checkpoint = progress.validationCheckpoint(
        base.chainId,
        base.collectionId,
        {
            chainId: base.chainId,
            blockNumber: base.anchorBlock,
            blockHash: base.anchorHash,
        },
    );
    return checkpoint &&
        checkpoint.revision === collection.checkpoint.revision &&
        checkpoint.block.number >= base.anchorBlock
        ? checkpoint
        : null;
}
