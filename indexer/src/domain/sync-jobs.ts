export {
    BACKFILL_ORDER_MAINTENANCE_POLICY,
    BACKFILL_SOURCE,
} from "@artgod/shared/types/sync-backfill";
import type { BackfillOrderMaintenancePolicy } from "@artgod/shared/types/sync-backfill";
import type { ReorgResyncIdentity } from "./reorg-recovery.js";
import {
    BACKFILL_SOURCE,
    BACKFILL_ORDER_MAINTENANCE_POLICY,
} from "@artgod/shared/types/sync-backfill";
import type { JobEnvelope } from "./jobs.js";
import { QUEUE_NAMES } from "./queues.js";
export type {
    BackfillOrderMaintenancePolicy,
    BackfillSource,
} from "@artgod/shared/types/sync-backfill";

export const SYNC_JOB_KIND = {
    RealtimeBlock: "sync.realtime.block",
    BackfillRange: "sync.backfill.range",
} as const;

export type RealtimeSyncPayload = {
    blockNumber: number;
};

type BackfillRangePayload = {
    fromBlock: number;
    toBlock: number;
    orderMaintenancePolicy: BackfillOrderMaintenancePolicy;
};

export type ReorgResyncPayload = BackfillRangePayload & {
    source: typeof BACKFILL_SOURCE.ReorgRecovery;
    orderMaintenancePolicy: typeof BACKFILL_ORDER_MAINTENANCE_POLICY.CurrentState;
    recovery: ReorgResyncIdentity;
    repairs?: never;
};

// A batch carries the retained intent for each member, independently of its
// broker identity. Bounds fence deliveries after a partially completed repair.
export type { SyncGapRepairTarget } from "./sync-gap-repair.js";
import type { SyncGapRepairTarget } from "./sync-gap-repair.js";

export type GapRepairSyncPayload = BackfillRangePayload & {
    source: typeof BACKFILL_SOURCE.GapRepair;
    orderMaintenancePolicy: typeof BACKFILL_ORDER_MAINTENANCE_POLICY.CurrentState;
    // Optional only to consume collection-scoped deliveries from older runtimes.
    repairs?: SyncGapRepairTarget[];
    recovery?: never;
};

export type BackfillSyncPayload =
    | ReorgResyncPayload
    | GapRepairSyncPayload
    | (BackfillRangePayload & {
          source: typeof BACKFILL_SOURCE.ManualHistorical;
          orderMaintenancePolicy: typeof BACKFILL_ORDER_MAINTENANCE_POLICY.SkipGlobalMakerRevalidation;
          repairs?: never;
          recovery?: never;
      })
    | (BackfillRangePayload & {
          source: typeof BACKFILL_SOURCE.BootstrapCatchup;
          orderMaintenancePolicy: typeof BACKFILL_ORDER_MAINTENANCE_POLICY.CurrentState;
          repairs?: never;
          recovery?: never;
      });

// Decode before choosing a processing lane. TypeScript's discriminated union
// cannot prevent an inconsistent source/member combination arriving over a queue.
export function decodeBackfillSyncJob(
    job: JobEnvelope,
): JobEnvelope<BackfillSyncPayload> | null {
    if (
        job.kind !== SYNC_JOB_KIND.BackfillRange ||
        job.queue !== QUEUE_NAMES.BackfillSync ||
        !isIntegerAtLeast(job.chainId, 1) ||
        (job.collectionId !== undefined &&
            !isIntegerAtLeast(job.collectionId, 1)) ||
        !isRecord(job.payload)
    )
        return null;
    const payload = job.payload;
    if (
        !isIntegerAtLeast(payload.fromBlock, 0) ||
        !isIntegerAtLeast(payload.toBlock, payload.fromBlock)
    )
        return null;
    let valid: boolean;
    switch (payload.source) {
        case BACKFILL_SOURCE.ManualHistorical:
            valid =
                payload.repairs === undefined &&
                payload.recovery === undefined &&
                payload.orderMaintenancePolicy ===
                    BACKFILL_ORDER_MAINTENANCE_POLICY.SkipGlobalMakerRevalidation;
            break;
        case BACKFILL_SOURCE.BootstrapCatchup:
            valid =
                payload.repairs === undefined &&
                payload.recovery === undefined &&
                payload.orderMaintenancePolicy ===
                    BACKFILL_ORDER_MAINTENANCE_POLICY.CurrentState;
            break;
        case BACKFILL_SOURCE.ReorgRecovery:
            valid =
                job.collectionId === undefined &&
                payload.repairs === undefined &&
                payload.orderMaintenancePolicy ===
                    BACKFILL_ORDER_MAINTENANCE_POLICY.CurrentState &&
                isRecord(payload.recovery) &&
                typeof payload.recovery.recoveryId === "string" &&
                !!payload.recovery.recoveryId &&
                isIntegerAtLeast(payload.recovery.revision, 0);
            break;
        case BACKFILL_SOURCE.GapRepair:
            valid =
                payload.fromBlock > 0 &&
                payload.recovery === undefined &&
                payload.orderMaintenancePolicy ===
                    BACKFILL_ORDER_MAINTENANCE_POLICY.CurrentState &&
                (payload.repairs === undefined
                    ? job.collectionId !== undefined
                    : job.collectionId === undefined &&
                      isGapRepairBatch(
                          payload.repairs,
                          payload.fromBlock,
                          payload.toBlock,
                      ));
            break;
        default:
            return null;
    }
    return valid ? (job as JobEnvelope<BackfillSyncPayload>) : null;
}

function isGapRepairBatch(
    value: unknown,
    fromBlock: number,
    toBlock: number,
): boolean {
    if (!Array.isArray(value) || !value.length) return false;
    const seen = new Set<number>();
    let firstBlock = Number.POSITIVE_INFINITY;
    let lastBlock = 0;
    for (const repair of value) {
        if (
            !isRecord(repair) ||
            !isIntegerAtLeast(repair.collectionId, 1) ||
            seen.has(repair.collectionId) ||
            typeof repair.repairId !== "string" ||
            !repair.repairId ||
            !isIntegerAtLeast(repair.anchorBlock, 1) ||
            !isIntegerAtLeast(repair.fromBlock, repair.anchorBlock) ||
            !isIntegerAtLeast(repair.toBlock, repair.fromBlock) ||
            repair.toBlock < fromBlock ||
            repair.toBlock > toBlock
        )
            return false;
        seen.add(repair.collectionId);
        firstBlock = Math.min(firstBlock, repair.fromBlock);
        lastBlock = Math.max(lastBlock, repair.toBlock);
    }
    // Retained batches can have a wider common range than one member.
    // Preserve that wire contract when consuming already queued work.
    return fromBlock >= firstBlock && toBlock === lastBlock;
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return !!value && typeof value === "object" && !Array.isArray(value);
}

function isIntegerAtLeast(value: unknown, minimum: number): value is number {
    return (
        typeof value === "number" &&
        Number.isSafeInteger(value) &&
        value >= minimum
    );
}
