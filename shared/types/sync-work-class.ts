/** Only automatic gap repairs and their descendants use the background allocation.
 * Manual backfills, bootstrap and recovery are main work, regardless of endpoint pool. */
export const SYNC_WORK_CLASS = {
    Main: "main",
    GapRepair: "gap_repair",
} as const;

export type SyncWorkClass =
    (typeof SYNC_WORK_CLASS)[keyof typeof SYNC_WORK_CLASS];

/** At persisted/queue boundaries, envelopes written before this contract are main work. */
export function decodeSyncWorkClass(value: unknown): SyncWorkClass {
    if (value === undefined || value === SYNC_WORK_CLASS.Main)
        return SYNC_WORK_CLASS.Main;
    if (value === SYNC_WORK_CLASS.GapRepair) return SYNC_WORK_CLASS.GapRepair;
    throw new Error("Invalid sync work class");
}

/** Coalescing background work cannot demote an outstanding main requirement. */
export function strongestSyncWorkClass(
    left: SyncWorkClass,
    right: SyncWorkClass,
): SyncWorkClass {
    return left === SYNC_WORK_CLASS.Main || right === SYNC_WORK_CLASS.Main
        ? SYNC_WORK_CLASS.Main
        : SYNC_WORK_CLASS.GapRepair;
}
