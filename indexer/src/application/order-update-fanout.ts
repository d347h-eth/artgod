import type { CollectionRecord } from "../domain/collections.js";
import {
    buildCanonicalOrderEffects,
    canonicalOrderEffectId,
} from "../domain/canonical-order-effects.js";
import type { JobEnvelope } from "../domain/jobs.js";
import type { OnChainData } from "../domain/onchain.js";
import { MAKER_TRIGGER_SCOPE, ORDER_JOB_KIND } from "../domain/order-jobs.js";
import {
    makerUpdateQueue,
    orderUpdateQueue,
} from "../domain/order-processing.js";
import type { BackfillOrderMaintenancePolicy } from "../domain/sync-jobs.js";
import {
    eventSyncFollowUp,
    type SyncFollowUp,
} from "../domain/sync-follow-ups.js";

/** Optional delivery uses the same domain classification as synchronous core
 * invalidation; it cannot introduce another set of lifecycle rules. */
export function buildOrderUpdateFollowUps(
    chainId: number,
    collections: CollectionRecord[],
    data: OnChainData,
    orderMaintenancePolicy: BackfillOrderMaintenancePolicy,
    applyingShared: boolean,
): SyncFollowUp[] {
    return buildCanonicalOrderEffects({
        chainId,
        collections,
        data,
        orderMaintenancePolicy,
        applyingShared,
    }).map((effect) => {
        const queue =
            effect.kind === ORDER_JOB_KIND.UpdateById
                ? orderUpdateQueue(effect.payload)
                : makerUpdateQueue(effect.payload);
        const job: JobEnvelope = {
            jobId: canonicalOrderEffectId(effect),
            kind: effect.kind,
            queue,
            payload: effect.payload,
            attempt: 0,
            scheduledAt: Date.now(),
            chainId,
            ...(effect.kind === ORDER_JOB_KIND.UpdateByMaker &&
            effect.payload.scope !== MAKER_TRIGGER_SCOPE.Global
                ? { collectionId: effect.payload.collectionId }
                : {}),
        };
        return eventSyncFollowUp(job, effect.payload);
    });
}

// Acquisition uses this coarse gate to decide whether global event reads can
// affect any current scope. Exact per-collection acceptance belongs to the owner.
export function canAnyCollectionProjectCurrentStateAt(
    collections: CollectionRecord[],
    blockNumber: number,
): boolean {
    return collections.some((collection) =>
        collection.canProjectCurrentStateAt(blockNumber),
    );
}
